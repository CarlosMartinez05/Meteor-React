(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var global = Package.meteor.global;
var meteorEnv = Package.meteor.meteorEnv;
var ECMAScript = Package.ecmascript.ECMAScript;
var meteorInstall = Package.modules.meteorInstall;
var Promise = Package.promise.Promise;

/* Package-scope variables */
var WebAppHashing;

var require = meteorInstall({"node_modules":{"meteor":{"webapp-hashing":{"webapp-hashing.js":function module(require,exports,module){

///////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                   //
// packages/webapp-hashing/webapp-hashing.js                                                         //
//                                                                                                   //
///////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                     //
const _excluded = ["autoupdateVersion", "autoupdateVersionRefreshable", "autoupdateVersionCordova"];

let _objectWithoutProperties;

module.link("@babel/runtime/helpers/objectWithoutProperties", {
  default(v) {
    _objectWithoutProperties = v;
  }

}, 0);
let createHash;
module.link("crypto", {
  createHash(v) {
    createHash = v;
  }

}, 0);
WebAppHashing = {}; // Calculate a hash of all the client resources downloaded by the
// browser, including the application HTML, runtime config, code, and
// static files.
//
// This hash *must* change if any resources seen by the browser
// change, and ideally *doesn't* change for any server-only changes
// (but the second is a performance enhancement, not a hard
// requirement).

WebAppHashing.calculateClientHash = function (manifest, includeFilter, runtimeConfigOverride) {
  var hash = createHash('sha1'); // Omit the old hashed client values in the new hash. These may be
  // modified in the new boilerplate.

  var {
    autoupdateVersion,
    autoupdateVersionRefreshable,
    autoupdateVersionCordova
  } = __meteor_runtime_config__,
      runtimeCfg = _objectWithoutProperties(__meteor_runtime_config__, _excluded);

  if (runtimeConfigOverride) {
    runtimeCfg = runtimeConfigOverride;
  }

  hash.update(JSON.stringify(runtimeCfg, 'utf8'));
  manifest.forEach(function (resource) {
    if ((!includeFilter || includeFilter(resource.type, resource.replaceable)) && (resource.where === 'client' || resource.where === 'internal')) {
      hash.update(resource.path);
      hash.update(resource.hash);
    }
  });
  return hash.digest('hex');
};

WebAppHashing.calculateCordovaCompatibilityHash = function (platformVersion, pluginVersions) {
  const hash = createHash('sha1');
  hash.update(platformVersion); // Sort plugins first so iteration order doesn't affect the hash

  const plugins = Object.keys(pluginVersions).sort();

  for (let plugin of plugins) {
    const version = pluginVersions[plugin];
    hash.update(plugin);
    hash.update(version);
  }

  return hash.digest('hex');
};
///////////////////////////////////////////////////////////////////////////////////////////////////////

}}}}},{
  "extensions": [
    ".js",
    ".json"
  ]
});

require("/node_modules/meteor/webapp-hashing/webapp-hashing.js");

/* Exports */
Package._define("webapp-hashing", {
  WebAppHashing: WebAppHashing
});

})();

//# sourceURL=meteor://💻app/packages/webapp-hashing.js
//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1ldGVvcjovL/CfkrthcHAvcGFja2FnZXMvd2ViYXBwLWhhc2hpbmcvd2ViYXBwLWhhc2hpbmcuanMiXSwibmFtZXMiOlsiX29iamVjdFdpdGhvdXRQcm9wZXJ0aWVzIiwibW9kdWxlIiwibGluayIsImRlZmF1bHQiLCJ2IiwiY3JlYXRlSGFzaCIsIldlYkFwcEhhc2hpbmciLCJjYWxjdWxhdGVDbGllbnRIYXNoIiwibWFuaWZlc3QiLCJpbmNsdWRlRmlsdGVyIiwicnVudGltZUNvbmZpZ092ZXJyaWRlIiwiaGFzaCIsImF1dG91cGRhdGVWZXJzaW9uIiwiYXV0b3VwZGF0ZVZlcnNpb25SZWZyZXNoYWJsZSIsImF1dG91cGRhdGVWZXJzaW9uQ29yZG92YSIsIl9fbWV0ZW9yX3J1bnRpbWVfY29uZmlnX18iLCJydW50aW1lQ2ZnIiwidXBkYXRlIiwiSlNPTiIsInN0cmluZ2lmeSIsImZvckVhY2giLCJyZXNvdXJjZSIsInR5cGUiLCJyZXBsYWNlYWJsZSIsIndoZXJlIiwicGF0aCIsImRpZ2VzdCIsImNhbGN1bGF0ZUNvcmRvdmFDb21wYXRpYmlsaXR5SGFzaCIsInBsYXRmb3JtVmVyc2lvbiIsInBsdWdpblZlcnNpb25zIiwicGx1Z2lucyIsIk9iamVjdCIsImtleXMiLCJzb3J0IiwicGx1Z2luIiwidmVyc2lvbiJdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxJQUFJQSx3QkFBSjs7QUFBNkJDLE1BQU0sQ0FBQ0MsSUFBUCxDQUFZLGdEQUFaLEVBQTZEO0FBQUNDLFNBQU8sQ0FBQ0MsQ0FBRCxFQUFHO0FBQUNKLDRCQUF3QixHQUFDSSxDQUF6QjtBQUEyQjs7QUFBdkMsQ0FBN0QsRUFBc0csQ0FBdEc7QUFBN0IsSUFBSUMsVUFBSjtBQUFlSixNQUFNLENBQUNDLElBQVAsQ0FBWSxRQUFaLEVBQXFCO0FBQUNHLFlBQVUsQ0FBQ0QsQ0FBRCxFQUFHO0FBQUNDLGNBQVUsR0FBQ0QsQ0FBWDtBQUFhOztBQUE1QixDQUFyQixFQUFtRCxDQUFuRDtBQUVmRSxhQUFhLEdBQUcsRUFBaEIsQyxDQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUFBLGFBQWEsQ0FBQ0MsbUJBQWQsR0FDRSxVQUFVQyxRQUFWLEVBQW9CQyxhQUFwQixFQUFtQ0MscUJBQW5DLEVBQTBEO0FBQzFELE1BQUlDLElBQUksR0FBR04sVUFBVSxDQUFDLE1BQUQsQ0FBckIsQ0FEMEQsQ0FHMUQ7QUFDQTs7QUFDQSxNQUFJO0FBQUVPLHFCQUFGO0FBQXFCQyxnQ0FBckI7QUFBbURDO0FBQW5ELE1BQStGQyx5QkFBbkc7QUFBQSxNQUFvRkMsVUFBcEYsNEJBQW1HRCx5QkFBbkc7O0FBRUEsTUFBSUwscUJBQUosRUFBMkI7QUFDekJNLGNBQVUsR0FBR04scUJBQWI7QUFDRDs7QUFFREMsTUFBSSxDQUFDTSxNQUFMLENBQVlDLElBQUksQ0FBQ0MsU0FBTCxDQUFlSCxVQUFmLEVBQTJCLE1BQTNCLENBQVo7QUFFQVIsVUFBUSxDQUFDWSxPQUFULENBQWlCLFVBQVVDLFFBQVYsRUFBb0I7QUFDakMsUUFBSSxDQUFDLENBQUVaLGFBQUYsSUFBbUJBLGFBQWEsQ0FBQ1ksUUFBUSxDQUFDQyxJQUFWLEVBQWdCRCxRQUFRLENBQUNFLFdBQXpCLENBQWpDLE1BQ0NGLFFBQVEsQ0FBQ0csS0FBVCxLQUFtQixRQUFuQixJQUErQkgsUUFBUSxDQUFDRyxLQUFULEtBQW1CLFVBRG5ELENBQUosRUFDb0U7QUFDcEViLFVBQUksQ0FBQ00sTUFBTCxDQUFZSSxRQUFRLENBQUNJLElBQXJCO0FBQ0FkLFVBQUksQ0FBQ00sTUFBTCxDQUFZSSxRQUFRLENBQUNWLElBQXJCO0FBQ0Q7QUFDRixHQU5EO0FBT0EsU0FBT0EsSUFBSSxDQUFDZSxNQUFMLENBQVksS0FBWixDQUFQO0FBQ0QsQ0F0QkQ7O0FBd0JBcEIsYUFBYSxDQUFDcUIsaUNBQWQsR0FDRSxVQUFTQyxlQUFULEVBQTBCQyxjQUExQixFQUEwQztBQUMxQyxRQUFNbEIsSUFBSSxHQUFHTixVQUFVLENBQUMsTUFBRCxDQUF2QjtBQUVBTSxNQUFJLENBQUNNLE1BQUwsQ0FBWVcsZUFBWixFQUgwQyxDQUsxQzs7QUFDQSxRQUFNRSxPQUFPLEdBQUdDLE1BQU0sQ0FBQ0MsSUFBUCxDQUFZSCxjQUFaLEVBQTRCSSxJQUE1QixFQUFoQjs7QUFDQSxPQUFLLElBQUlDLE1BQVQsSUFBbUJKLE9BQW5CLEVBQTRCO0FBQzFCLFVBQU1LLE9BQU8sR0FBR04sY0FBYyxDQUFDSyxNQUFELENBQTlCO0FBQ0F2QixRQUFJLENBQUNNLE1BQUwsQ0FBWWlCLE1BQVo7QUFDQXZCLFFBQUksQ0FBQ00sTUFBTCxDQUFZa0IsT0FBWjtBQUNEOztBQUVELFNBQU94QixJQUFJLENBQUNlLE1BQUwsQ0FBWSxLQUFaLENBQVA7QUFDRCxDQWZELEMiLCJmaWxlIjoiL3BhY2thZ2VzL3dlYmFwcC1oYXNoaW5nLmpzIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gXCJjcnlwdG9cIjtcblxuV2ViQXBwSGFzaGluZyA9IHt9O1xuXG4vLyBDYWxjdWxhdGUgYSBoYXNoIG9mIGFsbCB0aGUgY2xpZW50IHJlc291cmNlcyBkb3dubG9hZGVkIGJ5IHRoZVxuLy8gYnJvd3NlciwgaW5jbHVkaW5nIHRoZSBhcHBsaWNhdGlvbiBIVE1MLCBydW50aW1lIGNvbmZpZywgY29kZSwgYW5kXG4vLyBzdGF0aWMgZmlsZXMuXG4vL1xuLy8gVGhpcyBoYXNoICptdXN0KiBjaGFuZ2UgaWYgYW55IHJlc291cmNlcyBzZWVuIGJ5IHRoZSBicm93c2VyXG4vLyBjaGFuZ2UsIGFuZCBpZGVhbGx5ICpkb2Vzbid0KiBjaGFuZ2UgZm9yIGFueSBzZXJ2ZXItb25seSBjaGFuZ2VzXG4vLyAoYnV0IHRoZSBzZWNvbmQgaXMgYSBwZXJmb3JtYW5jZSBlbmhhbmNlbWVudCwgbm90IGEgaGFyZFxuLy8gcmVxdWlyZW1lbnQpLlxuXG5XZWJBcHBIYXNoaW5nLmNhbGN1bGF0ZUNsaWVudEhhc2ggPVxuICBmdW5jdGlvbiAobWFuaWZlc3QsIGluY2x1ZGVGaWx0ZXIsIHJ1bnRpbWVDb25maWdPdmVycmlkZSkge1xuICB2YXIgaGFzaCA9IGNyZWF0ZUhhc2goJ3NoYTEnKTtcblxuICAvLyBPbWl0IHRoZSBvbGQgaGFzaGVkIGNsaWVudCB2YWx1ZXMgaW4gdGhlIG5ldyBoYXNoLiBUaGVzZSBtYXkgYmVcbiAgLy8gbW9kaWZpZWQgaW4gdGhlIG5ldyBib2lsZXJwbGF0ZS5cbiAgdmFyIHsgYXV0b3VwZGF0ZVZlcnNpb24sIGF1dG91cGRhdGVWZXJzaW9uUmVmcmVzaGFibGUsIGF1dG91cGRhdGVWZXJzaW9uQ29yZG92YSwgLi4ucnVudGltZUNmZyB9ID0gX19tZXRlb3JfcnVudGltZV9jb25maWdfXztcblxuICBpZiAocnVudGltZUNvbmZpZ092ZXJyaWRlKSB7XG4gICAgcnVudGltZUNmZyA9IHJ1bnRpbWVDb25maWdPdmVycmlkZTtcbiAgfVxuXG4gIGhhc2gudXBkYXRlKEpTT04uc3RyaW5naWZ5KHJ1bnRpbWVDZmcsICd1dGY4JykpO1xuXG4gIG1hbmlmZXN0LmZvckVhY2goZnVuY3Rpb24gKHJlc291cmNlKSB7XG4gICAgICBpZiAoKCEgaW5jbHVkZUZpbHRlciB8fCBpbmNsdWRlRmlsdGVyKHJlc291cmNlLnR5cGUsIHJlc291cmNlLnJlcGxhY2VhYmxlKSkgJiZcbiAgICAgICAgICAocmVzb3VyY2Uud2hlcmUgPT09ICdjbGllbnQnIHx8IHJlc291cmNlLndoZXJlID09PSAnaW50ZXJuYWwnKSkge1xuICAgICAgaGFzaC51cGRhdGUocmVzb3VyY2UucGF0aCk7XG4gICAgICBoYXNoLnVwZGF0ZShyZXNvdXJjZS5oYXNoKTtcbiAgICB9XG4gIH0pO1xuICByZXR1cm4gaGFzaC5kaWdlc3QoJ2hleCcpO1xufTtcblxuV2ViQXBwSGFzaGluZy5jYWxjdWxhdGVDb3Jkb3ZhQ29tcGF0aWJpbGl0eUhhc2ggPVxuICBmdW5jdGlvbihwbGF0Zm9ybVZlcnNpb24sIHBsdWdpblZlcnNpb25zKSB7XG4gIGNvbnN0IGhhc2ggPSBjcmVhdGVIYXNoKCdzaGExJyk7XG5cbiAgaGFzaC51cGRhdGUocGxhdGZvcm1WZXJzaW9uKTtcblxuICAvLyBTb3J0IHBsdWdpbnMgZmlyc3Qgc28gaXRlcmF0aW9uIG9yZGVyIGRvZXNuJ3QgYWZmZWN0IHRoZSBoYXNoXG4gIGNvbnN0IHBsdWdpbnMgPSBPYmplY3Qua2V5cyhwbHVnaW5WZXJzaW9ucykuc29ydCgpO1xuICBmb3IgKGxldCBwbHVnaW4gb2YgcGx1Z2lucykge1xuICAgIGNvbnN0IHZlcnNpb24gPSBwbHVnaW5WZXJzaW9uc1twbHVnaW5dO1xuICAgIGhhc2gudXBkYXRlKHBsdWdpbik7XG4gICAgaGFzaC51cGRhdGUodmVyc2lvbik7XG4gIH1cblxuICByZXR1cm4gaGFzaC5kaWdlc3QoJ2hleCcpO1xufTtcbiJdfQ==
