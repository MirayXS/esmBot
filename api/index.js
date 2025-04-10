import "dotenv/config";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import EventEmitter from "node:events";
import logger from "#utils/logger.js";
import { img } from "#utils/imageLib.js";
import { Client } from "oceanic.js";
import run from "#utils/image-runner.js";

const formats = Object.keys(img.imageInit());

const Rerror = 0x01;
const Tqueue = 0x02;
const Rqueue = 0x03;
const Tcancel = 0x04;
const Rcancel = 0x05;
const Twait = 0x06;
const Rwait = 0x07;
const Rinit = 0x08;
const Rsent = 0x09;
const Rclose = 0xFF;

const log = (msg, jobNum) => {
  logger.log("main", `${jobNum != null ? `[Job ${jobNum}] ` : ""}${msg}`);
};
const error = (msg, jobNum) => {
  logger.error(`${jobNum != null ? `[Job ${jobNum}] ` : ""}${msg}`);
};

class JobCache extends Map {
  set(key, value) {
    super.set(key, value);
    setTimeout(() => {
      if (super.has(key) && this.get(key) === value && value.data) super.delete(key);
    }, 900000); // delete jobs if not requested after 15 minutes
    return this;
  }

  _delListener(_size) {}

  delete(key) {
    const out = super.delete(key);
    this._delListener(this.size);
    return out;
  }

  delListen(func) {
    this._delListener = func;
  }
}

const jobs = new JobCache();
// Should look like ID : { msg: "request", num: <job number> }

const PASS = process.env.PASS ? process.env.PASS : undefined;
let jobAmount = 0;

// Used for direct image uploads
const discord = new Client({
  rest: {
    baseURL: process.env.REST_PROXY && process.env.REST_PROXY !== "" ? process.env.REST_PROXY : undefined
  }
});
const clientID = process.env.CLIENT_ID;

discord.on("error", error);

/**
 * Accept an image job.
 * @param {string} id 
 * @param {import("ws").WebSocket} sock 
 * @returns {Promise<void>}
 */
const acceptJob = (id, sock) => {
  jobAmount++;
  const job = jobs.get(id);
  return runJob({
    id: id,
    msg: job.msg,
    num: job.num
  }, sock).then(() => {
    log(`Job ${id} has finished`);
  }).catch((err) => {
    error(`Error on job ${id}: ${err}`, job.num);
    const newJob = jobs.get(id);
    if (!newJob.tag) {
      newJob.error = err.message;
      jobs.set(id, newJob);
      return;
    }
    jobs.delete(id);
    sock.send(Buffer.concat([Buffer.from([Rerror]), newJob.tag, Buffer.from(err.message)]));
  }).finally(() => {
    jobAmount--;
  });
};

const waitForVerify = (event) => {
  return new Promise((resolve, reject) => {
    event.once("end", (r) => resolve(r));
    event.once("error", (e) => reject(e));
  });
};

const wss = new WebSocketServer({ clientTracking: true, noServer: true });

wss.on("connection", (ws, request) => {
  logger.log("info", `WS client ${request.socket.remoteAddress}:${request.socket.remotePort} has connected`);
  const cur = Buffer.alloc(2);
  cur.writeUInt16LE(jobAmount);
  const cmdFormats = {};
  for (const cmd of img.funcs) {
    cmdFormats[cmd] = formats;
  }
  const init = Buffer.concat([Buffer.from([Rinit]), Buffer.from([0x00, 0x00, 0x00, 0x00]), cur, Buffer.from(JSON.stringify(cmdFormats))]);
  ws.send(init);

  ws.on("error", (err) => {
    error(err);
  });

  ws.on("message", (msg) => {
    const opcode = msg.readUint8(0);
    const tag = msg.slice(1, 3);
    const req = msg.toString().slice(3);
    if (opcode === Tqueue) {
      const id = msg.readBigInt64LE(3);
      const obj = msg.slice(11);
      const job = { msg: obj, num: jobAmount, verifyEvent: new EventEmitter() };
      jobs.set(id, job);

      const newBuffer = Buffer.concat([Buffer.from([Rqueue]), tag]);
      ws.send(newBuffer);
  
        log(`Got WS request for job ${job.msg} with id ${id}`, job.num);
        acceptJob(id, ws);
    } else if (opcode === Tcancel) {
      jobs.delete(req);
      const cancelResponse = Buffer.concat([Buffer.from([Rcancel]), tag]);
      ws.send(cancelResponse);
    } else if (opcode === Twait) {
      const id = msg.readBigUInt64LE(3);
      const job = jobs.get(id);
      if (!job) {
        const errorResponse = Buffer.concat([Buffer.from([Rerror]), tag, Buffer.from("Invalid job ID")]);
        ws.send(errorResponse);
        return;
      }
      if (job.error) {
        job.verifyEvent.emit("error", job.error);
        jobs.delete(id);
        const errorResponse = Buffer.concat([Buffer.from([Rerror]), tag, Buffer.from(job.error)]);
        ws.send(errorResponse);
        return;
      }
      job.verifyEvent.emit("end", tag);
      job.tag = tag;
      jobs.set(id, job);
    } else {
      logger.warn("Could not parse WS message");
    }
  });

  ws.on("close", () => {
    logger.log("info", `WS client ${request.socket.remoteAddress}:${request.socket.remotePort} has disconnected`);
  });
});

wss.on("error", (err) => {
  logger.error("A WS error occurred: ", err);
});

const httpServer = createServer();

httpServer.on("request", async (req, res) => {
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end("405 Method Not Allowed");
  }
  if (PASS && req.headers.authentication !== PASS) {
    res.statusCode = 401;
    return res.end("401 Unauthorized");
  }
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  if (reqUrl.pathname === "/image" && req.method === "GET") {
    if (!reqUrl.searchParams.has("id")) {
      res.statusCode = 400;
      return res.end("400 Bad Request");
    }
    const id = BigInt(reqUrl.searchParams.get("id"));
    if (!jobs.has(id)) {
      res.statusCode = 410;
      return res.end("410 Gone");
    }
    log(`Sending image data for job ${id} to ${req.socket.remoteAddress}:${req.socket.remotePort} via HTTP`);
    const ext = jobs.get(id).ext;
    let contentType;
    switch (ext) {
      case "gif":
        contentType = "image/gif";
        break;
      case "png":
        contentType = "image/png";
        break;
      case "jpeg":
      case "jpg":
        contentType = "image/jpeg";
        break;
      case "webp":
        contentType = "image/webp";
        break;
      case "avif":
        contentType = "image/avif";
        break;
    }
    if (contentType) res.setHeader("Content-Type", contentType);
    else res.setHeader("Content-Type", ext);
    const data = jobs.get(id).data;
    jobs.delete(id);
    return res.end(data, (err) => {
      if (err) error(err);
    });
  }
  if (reqUrl.pathname === "/count" && req.method === "GET") {
    log(`Sending job count to ${req.socket.remoteAddress}:${req.socket.remotePort} via HTTP`);
    return res.end(jobAmount.toString(), (err) => {
      if (err) error(err);
    });
  }
  res.statusCode = 404;
  return res.end("404 Not Found");
});

httpServer.on("upgrade", (req, sock, head) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (PASS && req.headers.authentication !== PASS) {
    sock.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    sock.destroy();
    return;
  }

  if (reqUrl.pathname === "/sock") {
    wss.handleUpgrade(req, sock, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    sock.destroy();
  }
});

httpServer.on("error", (e) => {
  error("An HTTP error occurred: ", e);
});
const port = process.env.PORT && process.env.PORT !== "" ? Number.parseInt(process.env.PORT) : 3762;
httpServer.listen(port, () => {
  logger.info(`HTTP and WS listening on port ${port}`);
});

function stopHTTPServer() {
  httpServer.close((e) => {
    if (e) {
      error(e);
      process.exit(1);
    }
    logger.info("Stopped HTTP server");
    process.exit();
  });
}

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) {
    logger.info("Another SIGINT detected, forcing shutdown...");
    process.exit();
  }
  stopping = true;
  logger.info("SIGINT detected, finishing jobs and shutting down...");
  discord.disconnect();
  httpServer.removeAllListeners("upgrade");
  const closeResponse = Buffer.concat([Buffer.from([Rclose])]);
  for (const client of wss.clients) {
    client.send(closeResponse);
  }
  wss.close((e) => {
    if (e) {
      error(e);
      process.exit(1);
    }
    logger.info("Stopped WS server");
    if (jobs.size > 0) {
      jobs.delListen((size) => {
        if (size > 0) return;
        logger.info("All jobs finished");
        stopHTTPServer();
      });
    } else {
      stopHTTPServer();
    }
  });
});

const allowedExtensions = ["gif", "png", "jpeg", "jpg", "webp", "avif"];
const fileSize = 10485760;

/**
 * @param {{ buffer: ArrayBuffer; fileExtension: string; }} data
 * @param {{ id: string; msg: object; num: number; }} job 
 * @param {{ token: string; ephemeral: boolean; spoiler: boolean; cmd: string; }} object
 * @param {import("ws").WebSocket} ws 
 * @param {(value: void | PromiseLike<void>) => void} resolve
 */
function finishJob(data, job, object, ws, resolve) {
  log(`Sending result of job ${job.id}`, job.num);
  const jobObject = jobs.get(job.id);
  jobObject.data = data.buffer;
  jobObject.ext = data.fileExtension;
  let verifyPromise;
  if (!jobObject.tag) {
    verifyPromise = waitForVerify(jobObject.verifyEvent);
  } else {
    verifyPromise = Promise.resolve(jobObject.tag);
  }
  let tag;
  verifyPromise.then(t => {
    tag = t;
    jobs.set(job.id, jobObject);
    if (clientID && object.token && allowedExtensions.includes(jobObject.ext) && jobObject.data.length < fileSize) {
      return discord.rest.interactions.createFollowupMessage(clientID, object.token, {
        flags: object.ephemeral ? 64 : undefined,
        files: [{
          name: `${object.spoiler ? "SPOILER_" : ""}${object.cmd}.${jobObject.ext}`,
          contents: jobObject.data
        }]
        }).catch((e) => {
          error(`Error while sending job ${job.id}, will attempt to send back to the bot: ${e}`, job.num);
          return;
      });
    }
    return;
  }).then((r) => {
    if (r) jobs.delete(job.id);
    const waitResponse = Buffer.concat([Buffer.from([r ? Rsent : Rwait]), tag]);
    ws.send(waitResponse);
    resolve();
  });
}

/**
 * Run an image job.
 * @param {{ id: string; msg: object; num: number; }} job 
 * @param {import("ws").WebSocket} ws 
 * @returns {Promise<void>}
 */
const runJob = (job, ws) => {
  return new Promise((resolve, reject) => {
    log(`Job ${job.id} starting...`, job.num);

    const object = JSON.parse(job.msg);
    // If the image has a path, it must also have a type
    if (object.path && !object.params.type) {
      reject(new TypeError("Unknown image type"));
    }

    run(object).then(data => finishJob(data, job, object, ws, resolve), (e) => reject(e));
    log(`Job ${job.id} started`, job.num);
  });
};
