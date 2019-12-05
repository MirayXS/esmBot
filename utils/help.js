const pug = require("pug");
const collections = require("./collections.js");
const fs = require("fs");

module.exports = async (output) => {
  const commands = Array.from(collections.commands.keys());
  const categories = {
    general: [],
    moderation: [],
    tags: [],
    fun: [],
    images: [],
    soundboard: []
  };
  for (const command of commands) {
    const category = collections.info.get(command).category;
    const description = collections.info.get(command).description;
    const params = collections.info.get(command).params;
    if (category === 1) {
      categories.general.push(`<strong>${command}</strong>${params ? ` ${params}` : ""} - ${description}`);
    } else if (category === 2) {
      categories.moderation.push(`<strong>${command}</strong>${params ? ` ${params}` : ""} - ${description}`);
    } else if (category === 3) {
      categories.tags.push(`<strong>${command}</strong>${params ? ` ${params}` : ""} - ${description}`);
    } else if (category === 4) {
      categories.fun.push(`<strong>${command}</strong>${params ? ` ${params}` : ""} - ${description}`);
    } else if (category === 5) {
      categories.images.push(`<strong>${command}</strong>${params ? ` ${params}` : ""} - ${description}`);
    } else if (category === 6) {
      categories.soundboard.push(`<strong>${command}</strong>${params ? ` ${params}` : ""} - ${description}`);
    }
  }
  fs.writeFile(output, pug.renderFile("./assets/pages/help.pug", { commands: categories }), () => {
    console.log("The docs have been generated.");
  });
};