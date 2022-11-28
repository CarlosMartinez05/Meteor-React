var require = meteorInstall({"imports":{"api":{"Collections":{"PatientCollection.js":function module(require,exports,module){

///////////////////////////////////////////////////////////////////////
//                                                                   //
// imports/api/Collections/PatientCollection.js                      //
//                                                                   //
///////////////////////////////////////////////////////////////////////
                                                                     //
module.export({
  PatientCollection: () => PatientCollection
});
let Mongo;
module.link("meteor/mongo", {
  Mongo(v) {
    Mongo = v;
  }

}, 0);
const PatientCollection = new Mongo.Collection('Patients2');
///////////////////////////////////////////////////////////////////////

}}}},"server":{"main.js":function module(require,exports,module){

///////////////////////////////////////////////////////////////////////
//                                                                   //
// server/main.js                                                    //
//                                                                   //
///////////////////////////////////////////////////////////////////////
                                                                     //
module.link("../imports/api/Collections/PatientCollection");
///////////////////////////////////////////////////////////////////////

}}},{
  "extensions": [
    ".js",
    ".json",
    ".ts",
    ".mjs",
    ".jsx"
  ]
});

var exports = require("/server/main.js");
//# sourceURL=meteor://💻app/app/app.js
//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1ldGVvcjovL/CfkrthcHAvaW1wb3J0cy9hcGkvQ29sbGVjdGlvbnMvUGF0aWVudENvbGxlY3Rpb24uanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3NlcnZlci9tYWluLmpzIl0sIm5hbWVzIjpbIm1vZHVsZSIsImV4cG9ydCIsIlBhdGllbnRDb2xsZWN0aW9uIiwiTW9uZ28iLCJsaW5rIiwidiIsIkNvbGxlY3Rpb24iXSwibWFwcGluZ3MiOiI7Ozs7Ozs7O0FBQUFBLE1BQU0sQ0FBQ0MsTUFBUCxDQUFjO0FBQUNDLG1CQUFpQixFQUFDLE1BQUlBO0FBQXZCLENBQWQ7QUFBeUQsSUFBSUMsS0FBSjtBQUFVSCxNQUFNLENBQUNJLElBQVAsQ0FBWSxjQUFaLEVBQTJCO0FBQUNELE9BQUssQ0FBQ0UsQ0FBRCxFQUFHO0FBQUNGLFNBQUssR0FBQ0UsQ0FBTjtBQUFROztBQUFsQixDQUEzQixFQUErQyxDQUEvQztBQUU1RCxNQUFNSCxpQkFBaUIsR0FBRyxJQUFJQyxLQUFLLENBQUNHLFVBQVYsQ0FBcUIsV0FBckIsQ0FBMUIsQzs7Ozs7Ozs7Ozs7QUNGUE4sTUFBTSxDQUFDSSxJQUFQLENBQVksOENBQVosRSIsImZpbGUiOiIvYXBwLmpzIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHtNb25nb30gZnJvbSAnbWV0ZW9yL21vbmdvJ1xuXG5leHBvcnQgY29uc3QgUGF0aWVudENvbGxlY3Rpb24gPSBuZXcgTW9uZ28uQ29sbGVjdGlvbignUGF0aWVudHMyJykiLCJpbXBvcnQgJy4uL2ltcG9ydHMvYXBpL0NvbGxlY3Rpb25zL1BhdGllbnRDb2xsZWN0aW9uJ1xuIl19
