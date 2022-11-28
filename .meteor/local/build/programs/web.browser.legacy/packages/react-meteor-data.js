//////////////////////////////////////////////////////////////////////////
//                                                                      //
// This is a generated file. You can view the original                  //
// source in your browser if your browser supports source maps.         //
// Source maps are supported by all recent versions of Chrome, Safari,  //
// and Firefox, and by Internet Explorer 11.                            //
//                                                                      //
//////////////////////////////////////////////////////////////////////////


(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var global = Package.meteor.global;
var meteorEnv = Package.meteor.meteorEnv;
var Tracker = Package.tracker.Tracker;
var Deps = Package.tracker.Deps;
var meteorInstall = Package.modules.meteorInstall;
var meteorBabelHelpers = Package.modules.meteorBabelHelpers;
var Promise = Package.promise.Promise;
var Symbol = Package['ecmascript-runtime-client'].Symbol;
var Map = Package['ecmascript-runtime-client'].Map;
var Set = Package['ecmascript-runtime-client'].Set;

var require = meteorInstall({"node_modules":{"meteor":{"react-meteor-data":{"index.js":function module(require,exports,module){

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                    //
// packages/react-meteor-data/index.js                                                                                //
//                                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                      //
var React;
module.link("react", {
  "default": function (v) {
    React = v;
  }
}, 0);
module.link("./useTracker", {
  "default": "useTracker"
}, 1);
module.link("./withTracker.tsx", {
  "default": "withTracker"
}, 2);
module.link("./useFind", {
  useFind: "useFind"
}, 3);
module.link("./useSubscribe", {
  useSubscribe: "useSubscribe"
}, 4);

if (Meteor.isDevelopment) {
  var v = React.version.split('.');

  if (v[0] < 16 || v[0] == 16 && v[1] < 8) {
    console.warn('react-meteor-data 2.x requires React version >= 16.8.');
  }
}
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"useFind.ts":function module(require,exports,module){

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                    //
// packages/react-meteor-data/useFind.ts                                                                              //
//                                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                      //
var _typeof;

module.link("@babel/runtime/helpers/typeof", {
  default: function (v) {
    _typeof = v;
  }
}, 0);

var _slicedToArray;

module.link("@babel/runtime/helpers/slicedToArray", {
  default: function (v) {
    _slicedToArray = v;
  }
}, 1);

var _toConsumableArray;

module.link("@babel/runtime/helpers/toConsumableArray", {
  default: function (v) {
    _toConsumableArray = v;
  }
}, 2);
module.export({
  useFind: function () {
    return useFind;
  }
});
var Meteor;
module.link("meteor/meteor", {
  Meteor: function (v) {
    Meteor = v;
  }
}, 0);
var Mongo;
module.link("meteor/mongo", {
  Mongo: function (v) {
    Mongo = v;
  }
}, 1);
var useReducer, useMemo, useEffect, useRef;
module.link("react", {
  useReducer: function (v) {
    useReducer = v;
  },
  useMemo: function (v) {
    useMemo = v;
  },
  useEffect: function (v) {
    useEffect = v;
  },
  useRef: function (v) {
    useRef = v;
  }
}, 2);
var Tracker;
module.link("meteor/tracker", {
  Tracker: function (v) {
    Tracker = v;
  }
}, 3);

var useFindReducer = function (data, action) {
  switch (action.type) {
    case 'refresh':
      return action.data;

    case 'addedAt':
      return [].concat(_toConsumableArray(data.slice(0, action.atIndex)), [action.document], _toConsumableArray(data.slice(action.atIndex)));

    case 'changedAt':
      return [].concat(_toConsumableArray(data.slice(0, action.atIndex)), [action.document], _toConsumableArray(data.slice(action.atIndex + 1)));

    case 'removedAt':
      return [].concat(_toConsumableArray(data.slice(0, action.atIndex)), _toConsumableArray(data.slice(action.atIndex + 1)));

    case 'movedTo':
      var doc = data[action.fromIndex];
      var copy = [].concat(_toConsumableArray(data.slice(0, action.fromIndex)), _toConsumableArray(data.slice(action.fromIndex + 1)));
      copy.splice(action.toIndex, 0, doc);
      return copy;
  }
}; // Check for valid Cursor or null.
// On client, we should have a Mongo.Cursor (defined in
// https://github.com/meteor/meteor/blob/devel/packages/minimongo/cursor.js and
// https://github.com/meteor/meteor/blob/devel/packages/mongo/collection.js).
// On server, however, we instead get a private Cursor type from
// https://github.com/meteor/meteor/blob/devel/packages/mongo/mongo_driver.js
// which has fields _mongo and _cursorDescription.


var checkCursor = function (cursor) {
  if (cursor !== null && cursor !== undefined && !(cursor instanceof Mongo.Cursor) && !(cursor._mongo && cursor._cursorDescription)) {
    console.warn('Warning: useFind requires an instance of Mongo.Cursor. ' + 'Make sure you do NOT call .fetch() on your cursor.');
  }
}; // Synchronous data fetch. It uses cursor observing instead of cursor.fetch() because synchronous fetch will be deprecated.


var fetchData = function (cursor) {
  var data = [];
  var observer = cursor.observe({
    addedAt: function (document, atIndex, before) {
      data.splice(atIndex, 0, document);
    }
  });
  observer.stop();
  return data;
};

var useFindClient = function (factory) {
  var deps = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];
  var cursor = useMemo(function () {
    // To avoid creating side effects in render, opt out
    // of Tracker integration altogether.
    var cursor = Tracker.nonreactive(factory);

    if (Meteor.isDevelopment) {
      checkCursor(cursor);
    }

    return cursor;
  }, deps);

  var _useReducer = useReducer(useFindReducer, null, function () {
    if (!(cursor instanceof Mongo.Cursor)) {
      return [];
    }

    return fetchData(cursor);
  }),
      _useReducer2 = _slicedToArray(_useReducer, 2),
      data = _useReducer2[0],
      dispatch = _useReducer2[1]; // Store information about mounting the component.
  // It will be used to run code only if the component is updated.


  var didMount = useRef(false);
  useEffect(function () {
    if (!(cursor instanceof Mongo.Cursor)) {
      return;
    } // Fetch intitial data if cursor was changed.


    if (didMount.current) {
      var _data = fetchData(cursor);

      dispatch({
        type: 'refresh',
        data: _data
      });
    } else {
      didMount.current = true;
    }

    var observer = cursor.observe({
      addedAt: function (document, atIndex, before) {
        dispatch({
          type: 'addedAt',
          document: document,
          atIndex: atIndex
        });
      },
      changedAt: function (newDocument, oldDocument, atIndex) {
        dispatch({
          type: 'changedAt',
          document: newDocument,
          atIndex: atIndex
        });
      },
      removedAt: function (oldDocument, atIndex) {
        dispatch({
          type: 'removedAt',
          atIndex: atIndex
        });
      },
      movedTo: function (document, fromIndex, toIndex, before) {
        dispatch({
          type: 'movedTo',
          fromIndex: fromIndex,
          toIndex: toIndex
        });
      },
      // @ts-ignore
      _suppress_initial: true
    });
    return function () {
      observer.stop();
    };
  }, [cursor]);
  return data;
};

var useFindServer = function (factory, deps) {
  return Tracker.nonreactive(function () {
    var _cursor$fetch, _cursor$fetch2;

    var cursor = factory();
    if (Meteor.isDevelopment) checkCursor(cursor);
    return (_cursor$fetch = cursor === null || cursor === void 0 ? void 0 : (_cursor$fetch2 = cursor.fetch) === null || _cursor$fetch2 === void 0 ? void 0 : _cursor$fetch2.call(cursor)) !== null && _cursor$fetch !== void 0 ? _cursor$fetch : null;
  });
};

var useFind = Meteor.isServer ? useFindServer : useFindClient;

function useFindDev(factory) {
  var deps = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];

  function warn(expects, pos, arg, type) {
    console.warn("Warning: useFind expected a " + expects + " in it's " + pos + " argument " + ("(" + arg + "), but got type of `" + type + "`."));
  }

  if (typeof factory !== 'function') {
    warn("function", "1st", "reactiveFn", factory);
  }

  if (!deps || !Array.isArray(deps)) {
    warn("array", "2nd", "deps", _typeof(deps));
  }

  return useFind(factory, deps);
}

module.exportDefault(Meteor.isDevelopment ? useFindDev : useFind);
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"useSubscribe.ts":function module(require,exports,module){

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                    //
// packages/react-meteor-data/useSubscribe.ts                                                                         //
//                                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                      //
module.export({
  useSubscribe: function () {
    return useSubscribe;
  }
});
var Meteor;
module.link("meteor/meteor", {
  Meteor: function (v) {
    Meteor = v;
  }
}, 0);
var useTracker;
module.link("./useTracker", {
  "default": function (v) {
    useTracker = v;
  }
}, 1);

var useSubscribeClient = function (name) {
  for (var _len = arguments.length, args = new Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
    args[_key - 1] = arguments[_key];
  }

  var updateOnReady = false;
  var subscription;
  var isReady = useTracker(function () {
    var _Meteor;

    if (!name) return true;
    subscription = (_Meteor = Meteor).subscribe.apply(_Meteor, [name].concat(args));
    return subscription.ready();
  }, function () {
    return !updateOnReady;
  });
  return function () {
    updateOnReady = true;
    return !isReady;
  };
};

var useSubscribeServer = function (name) {
  return function () {
    return false;
  };
};

var useSubscribe = Meteor.isServer ? useSubscribeServer : useSubscribeClient;
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"useTracker.ts":function module(require,exports,module){

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                    //
// packages/react-meteor-data/useTracker.ts                                                                           //
//                                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                      //
var _typeof;

module.link("@babel/runtime/helpers/typeof", {
  default: function (v) {
    _typeof = v;
  }
}, 0);
var Meteor;
module.link("meteor/meteor", {
  Meteor: function (v) {
    Meteor = v;
  }
}, 0);
var Tracker;
module.link("meteor/tracker", {
  Tracker: function (v) {
    Tracker = v;
  }
}, 1);
var useReducer, useEffect, useRef, useMemo;
module.link("react", {
  useReducer: function (v) {
    useReducer = v;
  },
  useEffect: function (v) {
    useEffect = v;
  },
  useRef: function (v) {
    useRef = v;
  },
  useMemo: function (v) {
    useMemo = v;
  }
}, 2);

// Warns if data is a Mongo.Cursor or a POJO containing a Mongo.Cursor.
function checkCursor(data) {
  var shouldWarn = false;

  if (Package.mongo && Package.mongo.Mongo && data && _typeof(data) === 'object') {
    if (data instanceof Package.mongo.Mongo.Cursor) {
      shouldWarn = true;
    } else if (Object.getPrototypeOf(data) === Object.prototype) {
      Object.keys(data).forEach(function (key) {
        if (data[key] instanceof Package.mongo.Mongo.Cursor) {
          shouldWarn = true;
        }
      });
    }
  }

  if (shouldWarn) {
    console.warn('Warning: your reactive function is returning a Mongo cursor. ' + 'This value will not be reactive. You probably want to call ' + '`.fetch()` on the cursor before returning it.');
  }
} // Used to create a forceUpdate from useReducer. Forces update by
// incrementing a number whenever the dispatch method is invoked.


var fur = function (x) {
  return x + 1;
};

var useForceUpdate = function () {
  return useReducer(fur, 0)[1];
};

var useTrackerNoDeps = function (reactiveFn) {
  var skipUpdate = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : null;

  var _useRef = useRef({
    isMounted: false,
    trackerData: null
  }),
      refs = _useRef.current;

  var forceUpdate = useForceUpdate(); // Without deps, always dispose and recreate the computation with every render.

  if (refs.computation) {
    refs.computation.stop(); // @ts-ignore This makes TS think ref.computation is "never" set

    delete refs.computation;
  } // Use Tracker.nonreactive in case we are inside a Tracker Computation.
  // This can happen if someone calls `ReactDOM.render` inside a Computation.
  // In that case, we want to opt out of the normal behavior of nested
  // Computations, where if the outer one is invalidated or stopped,
  // it stops the inner one.


  Tracker.nonreactive(function () {
    return Tracker.autorun(function (c) {
      refs.computation = c;
      var data = reactiveFn(c);

      if (c.firstRun) {
        // Always run the reactiveFn on firstRun
        refs.trackerData = data;
      } else if (!skipUpdate || !skipUpdate(refs.trackerData, data)) {
        // For any reactive change, forceUpdate and let the next render rebuild the computation.
        forceUpdate();
      }
    });
  }); // To clean up side effects in render, stop the computation immediately

  if (!refs.isMounted) {
    Meteor.defer(function () {
      if (!refs.isMounted && refs.computation) {
        refs.computation.stop();
        delete refs.computation;
      }
    });
  }

  useEffect(function () {
    // Let subsequent renders know we are mounted (render is committed).
    refs.isMounted = true; // In some cases, the useEffect hook will run before Meteor.defer, such as
    // when React.lazy is used. In those cases, we might as well leave the
    // computation alone!

    if (!refs.computation) {
      // Render is committed, but we no longer have a computation. Invoke
      // forceUpdate and let the next render recreate the computation.
      if (!skipUpdate) {
        forceUpdate();
      } else {
        Tracker.nonreactive(function () {
          return Tracker.autorun(function (c) {
            var data = reactiveFn(c);
            refs.computation = c;

            if (!skipUpdate(refs.trackerData, data)) {
              // For any reactive change, forceUpdate and let the next render rebuild the computation.
              forceUpdate();
            }
          });
        });
      }
    } // stop the computation on unmount


    return function () {
      var _refs$computation;

      (_refs$computation = refs.computation) === null || _refs$computation === void 0 ? void 0 : _refs$computation.stop();
      delete refs.computation;
      refs.isMounted = false;
    };
  }, []);
  return refs.trackerData;
};

var useTrackerWithDeps = function (reactiveFn, deps) {
  var skipUpdate = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : null;
  var forceUpdate = useForceUpdate();

  var _useRef2 = useRef({
    reactiveFn: reactiveFn
  }),
      refs = _useRef2.current; // keep reactiveFn ref fresh


  refs.reactiveFn = reactiveFn;
  useMemo(function () {
    // To jive with the lifecycle interplay between Tracker/Subscribe, run the
    // reactive function in a computation, then stop it, to force flush cycle.
    var comp = Tracker.nonreactive(function () {
      return Tracker.autorun(function (c) {
        var data = refs.reactiveFn();

        if (c.firstRun) {
          refs.data = data;
        } else if (!skipUpdate || !skipUpdate(refs.data, data)) {
          refs.data = data;
          forceUpdate();
        }
      });
    }); // In some cases, the useEffect hook will run before Meteor.defer, such as
    // when React.lazy is used. This will allow it to be stopped earlier in
    // useEffect if needed.

    refs.comp = comp; // To avoid creating side effects in render, stop the computation immediately

    Meteor.defer(function () {
      if (!refs.isMounted && refs.comp) {
        refs.comp.stop();
        delete refs.comp;
      }
    });
  }, deps);
  useEffect(function () {
    // Let subsequent renders know we are mounted (render is committed).
    refs.isMounted = true;

    if (!refs.comp) {
      refs.comp = Tracker.nonreactive(function () {
        return Tracker.autorun(function (c) {
          var data = refs.reactiveFn(c);

          if (!skipUpdate || !skipUpdate(refs.data, data)) {
            refs.data = data;
            forceUpdate();
          }
        });
      });
    }

    return function () {
      refs.comp.stop();
      delete refs.comp;
      refs.isMounted = false;
    };
  }, deps);
  return refs.data;
};

function useTrackerClient(reactiveFn) {
  var deps = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : null;
  var skipUpdate = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : null;

  if (deps === null || deps === undefined || !Array.isArray(deps)) {
    if (typeof deps === "function") {
      skipUpdate = deps;
    }

    return useTrackerNoDeps(reactiveFn, skipUpdate);
  } else {
    return useTrackerWithDeps(reactiveFn, deps, skipUpdate);
  }
}

var useTrackerServer = function (reactiveFn) {
  return Tracker.nonreactive(reactiveFn);
}; // When rendering on the server, we don't want to use the Tracker.
// We only do the first rendering on the server so we can get the data right away


var useTracker = Meteor.isServer ? useTrackerServer : useTrackerClient;

function useTrackerDev(reactiveFn) {
  var deps = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : null;
  var skipUpdate = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : null;

  function warn(expects, pos, arg, type) {
    console.warn("Warning: useTracker expected a " + expects + " in it's " + pos + " argument " + ("(" + arg + "), but got type of `" + type + "`."));
  }

  if (typeof reactiveFn !== 'function') {
    warn("function", "1st", "reactiveFn", reactiveFn);
  }

  if (deps && skipUpdate && !Array.isArray(deps) && typeof skipUpdate === "function") {
    warn("array & function", "2nd and 3rd", "deps, skipUpdate", _typeof(deps) + " & " + _typeof(skipUpdate));
  } else {
    if (deps && !Array.isArray(deps) && typeof deps !== "function") {
      warn("array or function", "2nd", "deps or skipUpdate", _typeof(deps));
    }

    if (skipUpdate && typeof skipUpdate !== "function") {
      warn("function", "3rd", "skipUpdate", _typeof(skipUpdate));
    }
  }

  var data = useTracker(reactiveFn, deps, skipUpdate);
  checkCursor(data);
  return data;
}

module.exportDefault(Meteor.isDevelopment ? useTrackerDev : useTracker);
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"withTracker.tsx":function module(require,exports,module){

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                    //
// packages/react-meteor-data/withTracker.tsx                                                                         //
//                                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                      //
var _extends;

module.link("@babel/runtime/helpers/extends", {
  default: function (v) {
    _extends = v;
  }
}, 0);
module.export({
  "default": function () {
    return withTracker;
  }
});
var React, forwardRef, memo;
module.link("react", {
  "default": function (v) {
    React = v;
  },
  forwardRef: function (v) {
    forwardRef = v;
  },
  memo: function (v) {
    memo = v;
  }
}, 0);
var useTracker;
module.link("./useTracker", {
  "default": function (v) {
    useTracker = v;
  }
}, 1);

function withTracker(options) {
  return function (Component) {
    var getMeteorData = typeof options === 'function' ? options : options.getMeteorData;
    var WithTracker = /*#__PURE__*/forwardRef(function (props, ref) {
      var data = useTracker(function () {
        return getMeteorData(props) || {};
      }, options.skipUpdate);
      return /*#__PURE__*/React.createElement(Component, _extends({
        ref: ref
      }, props, data));
    });
    var _options$pure = options.pure,
        pure = _options$pure === void 0 ? true : _options$pure;
    return pure ? /*#__PURE__*/memo(WithTracker) : WithTracker;
  };
}
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}}}}},{
  "extensions": [
    ".js",
    ".json",
    ".ts",
    ".tsx"
  ]
});


/* Exports */
Package._define("react-meteor-data");

})();
