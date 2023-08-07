class Utility {
  static deleteIgnoredObj(obj) {
    if(obj==undefined)
      return undefined;
    Object.keys(obj).forEach((element) => {
      if (typeof obj[element] == "object") {
        if (obj[element].G_ignore) delete obj[element];
        else this.deleteIgnoredObj(obj[element]);
      }
    });
  }
  static delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
module.exports = Utility;
