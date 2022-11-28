(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var global = Package.meteor.global;
var meteorEnv = Package.meteor.meteorEnv;
var check = Package.check.check;
var Match = Package.check.Match;
var Random = Package.random.Random;
var EJSON = Package.ejson.EJSON;
var _ = Package.underscore._;
var Retry = Package.retry.Retry;
var MongoID = Package['mongo-id'].MongoID;
var DiffSequence = Package['diff-sequence'].DiffSequence;
var ECMAScript = Package.ecmascript.ECMAScript;
var DDPCommon = Package['ddp-common'].DDPCommon;
var DDP = Package['ddp-client'].DDP;
var WebApp = Package.webapp.WebApp;
var WebAppInternals = Package.webapp.WebAppInternals;
var main = Package.webapp.main;
var RoutePolicy = Package.routepolicy.RoutePolicy;
var Hook = Package['callback-hook'].Hook;
var meteorInstall = Package.modules.meteorInstall;
var Promise = Package.promise.Promise;

/* Package-scope variables */
var StreamServer, DDPServer, id, Server;

var require = meteorInstall({"node_modules":{"meteor":{"ddp-server":{"stream_server.js":function module(require){

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                    //
// packages/ddp-server/stream_server.js                                                                               //
//                                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                      //
// By default, we use the permessage-deflate extension with default
// configuration. If $SERVER_WEBSOCKET_COMPRESSION is set, then it must be valid
// JSON. If it represents a falsey value, then we do not use permessage-deflate
// at all; otherwise, the JSON value is used as an argument to deflate's
// configure method; see
// https://github.com/faye/permessage-deflate-node/blob/master/README.md
//
// (We do this in an _.once instead of at startup, because we don't want to
// crash the tool during isopacket load if your JSON doesn't parse. This is only
// a problem because the tool has to load the DDP server code just in order to
// be a DDP client; see https://github.com/meteor/meteor/issues/3452 .)
var websocketExtensions = _.once(function () {
  var extensions = [];
  var websocketCompressionConfig = process.env.SERVER_WEBSOCKET_COMPRESSION ? JSON.parse(process.env.SERVER_WEBSOCKET_COMPRESSION) : {};

  if (websocketCompressionConfig) {
    extensions.push(Npm.require('permessage-deflate').configure(websocketCompressionConfig));
  }

  return extensions;
});

var pathPrefix = __meteor_runtime_config__.ROOT_URL_PATH_PREFIX || "";

StreamServer = function () {
  var self = this;
  self.registration_callbacks = [];
  self.open_sockets = []; // Because we are installing directly onto WebApp.httpServer instead of using
  // WebApp.app, we have to process the path prefix ourselves.

  self.prefix = pathPrefix + '/sockjs';
  RoutePolicy.declare(self.prefix + '/', 'network'); // set up sockjs

  var sockjs = Npm.require('sockjs');

  var serverOptions = {
    prefix: self.prefix,
    log: function () {},
    // this is the default, but we code it explicitly because we depend
    // on it in stream_client:HEARTBEAT_TIMEOUT
    heartbeat_delay: 45000,
    // The default disconnect_delay is 5 seconds, but if the server ends up CPU
    // bound for that much time, SockJS might not notice that the user has
    // reconnected because the timer (of disconnect_delay ms) can fire before
    // SockJS processes the new connection. Eventually we'll fix this by not
    // combining CPU-heavy processing with SockJS termination (eg a proxy which
    // converts to Unix sockets) but for now, raise the delay.
    disconnect_delay: 60 * 1000,
    // Set the USE_JSESSIONID environment variable to enable setting the
    // JSESSIONID cookie. This is useful for setting up proxies with
    // session affinity.
    jsessionid: !!process.env.USE_JSESSIONID
  }; // If you know your server environment (eg, proxies) will prevent websockets
  // from ever working, set $DISABLE_WEBSOCKETS and SockJS clients (ie,
  // browsers) will not waste time attempting to use them.
  // (Your server will still have a /websocket endpoint.)

  if (process.env.DISABLE_WEBSOCKETS) {
    serverOptions.websocket = false;
  } else {
    serverOptions.faye_server_options = {
      extensions: websocketExtensions()
    };
  }

  self.server = sockjs.createServer(serverOptions); // Install the sockjs handlers, but we want to keep around our own particular
  // request handler that adjusts idle timeouts while we have an outstanding
  // request.  This compensates for the fact that sockjs removes all listeners
  // for "request" to add its own.

  WebApp.httpServer.removeListener('request', WebApp._timeoutAdjustmentRequestCallback);
  self.server.installHandlers(WebApp.httpServer);
  WebApp.httpServer.addListener('request', WebApp._timeoutAdjustmentRequestCallback); // Support the /websocket endpoint

  self._redirectWebsocketEndpoint();

  self.server.on('connection', function (socket) {
    // sockjs sometimes passes us null instead of a socket object
    // so we need to guard against that. see:
    // https://github.com/sockjs/sockjs-node/issues/121
    // https://github.com/meteor/meteor/issues/10468
    if (!socket) return; // We want to make sure that if a client connects to us and does the initial
    // Websocket handshake but never gets to the DDP handshake, that we
    // eventually kill the socket.  Once the DDP handshake happens, DDP
    // heartbeating will work. And before the Websocket handshake, the timeouts
    // we set at the server level in webapp_server.js will work. But
    // faye-websocket calls setTimeout(0) on any socket it takes over, so there
    // is an "in between" state where this doesn't happen.  We work around this
    // by explicitly setting the socket timeout to a relatively large time here,
    // and setting it back to zero when we set up the heartbeat in
    // livedata_server.js.

    socket.setWebsocketTimeout = function (timeout) {
      if ((socket.protocol === 'websocket' || socket.protocol === 'websocket-raw') && socket._session.recv) {
        socket._session.recv.connection.setTimeout(timeout);
      }
    };

    socket.setWebsocketTimeout(45 * 1000);

    socket.send = function (data) {
      socket.write(data);
    };

    socket.on('close', function () {
      self.open_sockets = _.without(self.open_sockets, socket);
    });
    self.open_sockets.push(socket); // only to send a message after connection on tests, useful for
    // socket-stream-client/server-tests.js

    if (process.env.TEST_METADATA && process.env.TEST_METADATA !== "{}") {
      socket.send(JSON.stringify({
        testMessageOnConnect: true
      }));
    } // call all our callbacks when we get a new socket. they will do the
    // work of setting up handlers and such for specific messages.


    _.each(self.registration_callbacks, function (callback) {
      callback(socket);
    });
  });
};

Object.assign(StreamServer.prototype, {
  // call my callback when a new socket connects.
  // also call it for all current connections.
  register: function (callback) {
    var self = this;
    self.registration_callbacks.push(callback);

    _.each(self.all_sockets(), function (socket) {
      callback(socket);
    });
  },
  // get a list of all sockets
  all_sockets: function () {
    var self = this;
    return _.values(self.open_sockets);
  },
  // Redirect /websocket to /sockjs/websocket in order to not expose
  // sockjs to clients that want to use raw websockets
  _redirectWebsocketEndpoint: function () {
    var self = this; // Unfortunately we can't use a connect middleware here since
    // sockjs installs itself prior to all existing listeners
    // (meaning prior to any connect middlewares) so we need to take
    // an approach similar to overshadowListeners in
    // https://github.com/sockjs/sockjs-node/blob/cf820c55af6a9953e16558555a31decea554f70e/src/utils.coffee

    ['request', 'upgrade'].forEach(event => {
      var httpServer = WebApp.httpServer;
      var oldHttpServerListeners = httpServer.listeners(event).slice(0);
      httpServer.removeAllListeners(event); // request and upgrade have different arguments passed but
      // we only care about the first one which is always request

      var newListener = function (request
      /*, moreArguments */
      ) {
        // Store arguments for use within the closure below
        var args = arguments; // TODO replace with url package

        var url = Npm.require('url'); // Rewrite /websocket and /websocket/ urls to /sockjs/websocket while
        // preserving query string.


        var parsedUrl = url.parse(request.url);

        if (parsedUrl.pathname === pathPrefix + '/websocket' || parsedUrl.pathname === pathPrefix + '/websocket/') {
          parsedUrl.pathname = self.prefix + '/websocket';
          request.url = url.format(parsedUrl);
        }

        _.each(oldHttpServerListeners, function (oldListener) {
          oldListener.apply(httpServer, args);
        });
      };

      httpServer.addListener(event, newListener);
    });
  }
});
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"livedata_server.js":function module(require,exports,module){

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                    //
// packages/ddp-server/livedata_server.js                                                                             //
//                                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                      //
let _objectSpread;

module.link("@babel/runtime/helpers/objectSpread2", {
  default(v) {
    _objectSpread = v;
  }

}, 0);
DDPServer = {};

var Fiber = Npm.require('fibers'); // Publication strategies define how we handle data from published cursors at the collection level
// This allows someone to:
// - Choose a trade-off between client-server bandwidth and server memory usage
// - Implement special (non-mongo) collections like volatile message queues


const publicationStrategies = {
  // SERVER_MERGE is the default strategy.
  // When using this strategy, the server maintains a copy of all data a connection is subscribed to.
  // This allows us to only send deltas over multiple publications.
  SERVER_MERGE: {
    useCollectionView: true,
    doAccountingForCollection: true
  },
  // The NO_MERGE_NO_HISTORY strategy results in the server sending all publication data
  // directly to the client. It does not remember what it has previously sent
  // to it will not trigger removed messages when a subscription is stopped.
  // This should only be chosen for special use cases like send-and-forget queues.
  NO_MERGE_NO_HISTORY: {
    useCollectionView: false,
    doAccountingForCollection: false
  },
  // NO_MERGE is similar to NO_MERGE_NO_HISTORY but the server will remember the IDs it has
  // sent to the client so it can remove them when a subscription is stopped.
  // This strategy can be used when a collection is only used in a single publication.
  NO_MERGE: {
    useCollectionView: false,
    doAccountingForCollection: true
  }
};
DDPServer.publicationStrategies = publicationStrategies; // This file contains classes:
// * Session - The server's connection to a single DDP client
// * Subscription - A single subscription for a single client
// * Server - An entire server that may talk to > 1 client. A DDP endpoint.
//
// Session and Subscription are file scope. For now, until we freeze
// the interface, Server is package scope (in the future it should be
// exported).
// Represents a single document in a SessionCollectionView

var SessionDocumentView = function () {
  var self = this;
  self.existsIn = new Set(); // set of subscriptionHandle

  self.dataByKey = new Map(); // key-> [ {subscriptionHandle, value} by precedence]
};

DDPServer._SessionDocumentView = SessionDocumentView;

_.extend(SessionDocumentView.prototype, {
  getFields: function () {
    var self = this;
    var ret = {};
    self.dataByKey.forEach(function (precedenceList, key) {
      ret[key] = precedenceList[0].value;
    });
    return ret;
  },
  clearField: function (subscriptionHandle, key, changeCollector) {
    var self = this; // Publish API ignores _id if present in fields

    if (key === "_id") return;
    var precedenceList = self.dataByKey.get(key); // It's okay to clear fields that didn't exist. No need to throw
    // an error.

    if (!precedenceList) return;
    var removedValue = undefined;

    for (var i = 0; i < precedenceList.length; i++) {
      var precedence = precedenceList[i];

      if (precedence.subscriptionHandle === subscriptionHandle) {
        // The view's value can only change if this subscription is the one that
        // used to have precedence.
        if (i === 0) removedValue = precedence.value;
        precedenceList.splice(i, 1);
        break;
      }
    }

    if (precedenceList.length === 0) {
      self.dataByKey.delete(key);
      changeCollector[key] = undefined;
    } else if (removedValue !== undefined && !EJSON.equals(removedValue, precedenceList[0].value)) {
      changeCollector[key] = precedenceList[0].value;
    }
  },
  changeField: function (subscriptionHandle, key, value, changeCollector, isAdd) {
    var self = this; // Publish API ignores _id if present in fields

    if (key === "_id") return; // Don't share state with the data passed in by the user.

    value = EJSON.clone(value);

    if (!self.dataByKey.has(key)) {
      self.dataByKey.set(key, [{
        subscriptionHandle: subscriptionHandle,
        value: value
      }]);
      changeCollector[key] = value;
      return;
    }

    var precedenceList = self.dataByKey.get(key);
    var elt;

    if (!isAdd) {
      elt = precedenceList.find(function (precedence) {
        return precedence.subscriptionHandle === subscriptionHandle;
      });
    }

    if (elt) {
      if (elt === precedenceList[0] && !EJSON.equals(value, elt.value)) {
        // this subscription is changing the value of this field.
        changeCollector[key] = value;
      }

      elt.value = value;
    } else {
      // this subscription is newly caring about this field
      precedenceList.push({
        subscriptionHandle: subscriptionHandle,
        value: value
      });
    }
  }
});
/**
 * Represents a client's view of a single collection
 * @param {String} collectionName Name of the collection it represents
 * @param {Object.<String, Function>} sessionCallbacks The callbacks for added, changed, removed
 * @class SessionCollectionView
 */


var SessionCollectionView = function (collectionName, sessionCallbacks) {
  var self = this;
  self.collectionName = collectionName;
  self.documents = new Map();
  self.callbacks = sessionCallbacks;
};

DDPServer._SessionCollectionView = SessionCollectionView;
Object.assign(SessionCollectionView.prototype, {
  isEmpty: function () {
    var self = this;
    return self.documents.size === 0;
  },
  diff: function (previous) {
    var self = this;
    DiffSequence.diffMaps(previous.documents, self.documents, {
      both: _.bind(self.diffDocument, self),
      rightOnly: function (id, nowDV) {
        self.callbacks.added(self.collectionName, id, nowDV.getFields());
      },
      leftOnly: function (id, prevDV) {
        self.callbacks.removed(self.collectionName, id);
      }
    });
  },
  diffDocument: function (id, prevDV, nowDV) {
    var self = this;
    var fields = {};
    DiffSequence.diffObjects(prevDV.getFields(), nowDV.getFields(), {
      both: function (key, prev, now) {
        if (!EJSON.equals(prev, now)) fields[key] = now;
      },
      rightOnly: function (key, now) {
        fields[key] = now;
      },
      leftOnly: function (key, prev) {
        fields[key] = undefined;
      }
    });
    self.callbacks.changed(self.collectionName, id, fields);
  },
  added: function (subscriptionHandle, id, fields) {
    var self = this;
    var docView = self.documents.get(id);
    var added = false;

    if (!docView) {
      added = true;
      docView = new SessionDocumentView();
      self.documents.set(id, docView);
    }

    docView.existsIn.add(subscriptionHandle);
    var changeCollector = {};

    _.each(fields, function (value, key) {
      docView.changeField(subscriptionHandle, key, value, changeCollector, true);
    });

    if (added) self.callbacks.added(self.collectionName, id, changeCollector);else self.callbacks.changed(self.collectionName, id, changeCollector);
  },
  changed: function (subscriptionHandle, id, changed) {
    var self = this;
    var changedResult = {};
    var docView = self.documents.get(id);
    if (!docView) throw new Error("Could not find element with id " + id + " to change");

    _.each(changed, function (value, key) {
      if (value === undefined) docView.clearField(subscriptionHandle, key, changedResult);else docView.changeField(subscriptionHandle, key, value, changedResult);
    });

    self.callbacks.changed(self.collectionName, id, changedResult);
  },
  removed: function (subscriptionHandle, id) {
    var self = this;
    var docView = self.documents.get(id);

    if (!docView) {
      var err = new Error("Removed nonexistent document " + id);
      throw err;
    }

    docView.existsIn.delete(subscriptionHandle);

    if (docView.existsIn.size === 0) {
      // it is gone from everyone
      self.callbacks.removed(self.collectionName, id);
      self.documents.delete(id);
    } else {
      var changed = {}; // remove this subscription from every precedence list
      // and record the changes

      docView.dataByKey.forEach(function (precedenceList, key) {
        docView.clearField(subscriptionHandle, key, changed);
      });
      self.callbacks.changed(self.collectionName, id, changed);
    }
  }
});
/******************************************************************************/

/* Session                                                                    */

/******************************************************************************/

var Session = function (server, version, socket, options) {
  var self = this;
  self.id = Random.id();
  self.server = server;
  self.version = version;
  self.initialized = false;
  self.socket = socket; // Set to null when the session is destroyed. Multiple places below
  // use this to determine if the session is alive or not.

  self.inQueue = new Meteor._DoubleEndedQueue();
  self.blocked = false;
  self.workerRunning = false;
  self.cachedUnblock = null; // Sub objects for active subscriptions

  self._namedSubs = new Map();
  self._universalSubs = [];
  self.userId = null;
  self.collectionViews = new Map(); // Set this to false to not send messages when collectionViews are
  // modified. This is done when rerunning subs in _setUserId and those messages
  // are calculated via a diff instead.

  self._isSending = true; // If this is true, don't start a newly-created universal publisher on this
  // session. The session will take care of starting it when appropriate.

  self._dontStartNewUniversalSubs = false; // When we are rerunning subscriptions, any ready messages
  // we want to buffer up for when we are done rerunning subscriptions

  self._pendingReady = []; // List of callbacks to call when this connection is closed.

  self._closeCallbacks = []; // XXX HACK: If a sockjs connection, save off the URL. This is
  // temporary and will go away in the near future.

  self._socketUrl = socket.url; // Allow tests to disable responding to pings.

  self._respondToPings = options.respondToPings; // This object is the public interface to the session. In the public
  // API, it is called the `connection` object.  Internally we call it
  // a `connectionHandle` to avoid ambiguity.

  self.connectionHandle = {
    id: self.id,
    close: function () {
      self.close();
    },
    onClose: function (fn) {
      var cb = Meteor.bindEnvironment(fn, "connection onClose callback");

      if (self.inQueue) {
        self._closeCallbacks.push(cb);
      } else {
        // if we're already closed, call the callback.
        Meteor.defer(cb);
      }
    },
    clientAddress: self._clientAddress(),
    httpHeaders: self.socket.headers
  };
  self.send({
    msg: 'connected',
    session: self.id
  }); // On initial connect, spin up all the universal publishers.

  Fiber(function () {
    self.startUniversalSubs();
  }).run();

  if (version !== 'pre1' && options.heartbeatInterval !== 0) {
    // We no longer need the low level timeout because we have heartbeats.
    socket.setWebsocketTimeout(0);
    self.heartbeat = new DDPCommon.Heartbeat({
      heartbeatInterval: options.heartbeatInterval,
      heartbeatTimeout: options.heartbeatTimeout,
      onTimeout: function () {
        self.close();
      },
      sendPing: function () {
        self.send({
          msg: 'ping'
        });
      }
    });
    self.heartbeat.start();
  }

  Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("livedata", "sessions", 1);
};

Object.assign(Session.prototype, {
  sendReady: function (subscriptionIds) {
    var self = this;
    if (self._isSending) self.send({
      msg: "ready",
      subs: subscriptionIds
    });else {
      _.each(subscriptionIds, function (subscriptionId) {
        self._pendingReady.push(subscriptionId);
      });
    }
  },

  _canSend(collectionName) {
    return this._isSending || !this.server.getPublicationStrategy(collectionName).useCollectionView;
  },

  sendAdded(collectionName, id, fields) {
    if (this._canSend(collectionName)) this.send({
      msg: "added",
      collection: collectionName,
      id,
      fields
    });
  },

  sendChanged(collectionName, id, fields) {
    if (_.isEmpty(fields)) return;

    if (this._canSend(collectionName)) {
      this.send({
        msg: "changed",
        collection: collectionName,
        id,
        fields
      });
    }
  },

  sendRemoved(collectionName, id) {
    if (this._canSend(collectionName)) this.send({
      msg: "removed",
      collection: collectionName,
      id
    });
  },

  getSendCallbacks: function () {
    var self = this;
    return {
      added: _.bind(self.sendAdded, self),
      changed: _.bind(self.sendChanged, self),
      removed: _.bind(self.sendRemoved, self)
    };
  },
  getCollectionView: function (collectionName) {
    var self = this;
    var ret = self.collectionViews.get(collectionName);

    if (!ret) {
      ret = new SessionCollectionView(collectionName, self.getSendCallbacks());
      self.collectionViews.set(collectionName, ret);
    }

    return ret;
  },

  added(subscriptionHandle, collectionName, id, fields) {
    if (this.server.getPublicationStrategy(collectionName).useCollectionView) {
      const view = this.getCollectionView(collectionName);
      view.added(subscriptionHandle, id, fields);
    } else {
      this.sendAdded(collectionName, id, fields);
    }
  },

  removed(subscriptionHandle, collectionName, id) {
    if (this.server.getPublicationStrategy(collectionName).useCollectionView) {
      const view = this.getCollectionView(collectionName);
      view.removed(subscriptionHandle, id);

      if (view.isEmpty()) {
        this.collectionViews.delete(collectionName);
      }
    } else {
      this.sendRemoved(collectionName, id);
    }
  },

  changed(subscriptionHandle, collectionName, id, fields) {
    if (this.server.getPublicationStrategy(collectionName).useCollectionView) {
      const view = this.getCollectionView(collectionName);
      view.changed(subscriptionHandle, id, fields);
    } else {
      this.sendChanged(collectionName, id, fields);
    }
  },

  startUniversalSubs: function () {
    var self = this; // Make a shallow copy of the set of universal handlers and start them. If
    // additional universal publishers start while we're running them (due to
    // yielding), they will run separately as part of Server.publish.

    var handlers = _.clone(self.server.universal_publish_handlers);

    _.each(handlers, function (handler) {
      self._startSubscription(handler);
    });
  },
  // Destroy this session and unregister it at the server.
  close: function () {
    var self = this; // Destroy this session, even if it's not registered at the
    // server. Stop all processing and tear everything down. If a socket
    // was attached, close it.
    // Already destroyed.

    if (!self.inQueue) return; // Drop the merge box data immediately.

    self.inQueue = null;
    self.collectionViews = new Map();

    if (self.heartbeat) {
      self.heartbeat.stop();
      self.heartbeat = null;
    }

    if (self.socket) {
      self.socket.close();
      self.socket._meteorSession = null;
    }

    Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("livedata", "sessions", -1);
    Meteor.defer(function () {
      // Stop callbacks can yield, so we defer this on close.
      // sub._isDeactivated() detects that we set inQueue to null and
      // treats it as semi-deactivated (it will ignore incoming callbacks, etc).
      self._deactivateAllSubscriptions(); // Defer calling the close callbacks, so that the caller closing
      // the session isn't waiting for all the callbacks to complete.


      _.each(self._closeCallbacks, function (callback) {
        callback();
      });
    }); // Unregister the session.

    self.server._removeSession(self);
  },
  // Send a message (doing nothing if no socket is connected right now).
  // It should be a JSON object (it will be stringified).
  send: function (msg) {
    var self = this;

    if (self.socket) {
      if (Meteor._printSentDDP) Meteor._debug("Sent DDP", DDPCommon.stringifyDDP(msg));
      self.socket.send(DDPCommon.stringifyDDP(msg));
    }
  },
  // Send a connection error.
  sendError: function (reason, offendingMessage) {
    var self = this;
    var msg = {
      msg: 'error',
      reason: reason
    };
    if (offendingMessage) msg.offendingMessage = offendingMessage;
    self.send(msg);
  },
  // Process 'msg' as an incoming message. As a guard against
  // race conditions during reconnection, ignore the message if
  // 'socket' is not the currently connected socket.
  //
  // We run the messages from the client one at a time, in the order
  // given by the client. The message handler is passed an idempotent
  // function 'unblock' which it may call to allow other messages to
  // begin running in parallel in another fiber (for example, a method
  // that wants to yield). Otherwise, it is automatically unblocked
  // when it returns.
  //
  // Actually, we don't have to 'totally order' the messages in this
  // way, but it's the easiest thing that's correct. (unsub needs to
  // be ordered against sub, methods need to be ordered against each
  // other).
  processMessage: function (msg_in) {
    var self = this;
    if (!self.inQueue) // we have been destroyed.
      return; // Respond to ping and pong messages immediately without queuing.
    // If the negotiated DDP version is "pre1" which didn't support
    // pings, preserve the "pre1" behavior of responding with a "bad
    // request" for the unknown messages.
    //
    // Fibers are needed because heartbeats use Meteor.setTimeout, which
    // needs a Fiber. We could actually use regular setTimeout and avoid
    // these new fibers, but it is easier to just make everything use
    // Meteor.setTimeout and not think too hard.
    //
    // Any message counts as receiving a pong, as it demonstrates that
    // the client is still alive.

    if (self.heartbeat) {
      Fiber(function () {
        self.heartbeat.messageReceived();
      }).run();
    }

    if (self.version !== 'pre1' && msg_in.msg === 'ping') {
      if (self._respondToPings) self.send({
        msg: "pong",
        id: msg_in.id
      });
      return;
    }

    if (self.version !== 'pre1' && msg_in.msg === 'pong') {
      // Since everything is a pong, there is nothing to do
      return;
    }

    self.inQueue.push(msg_in);
    if (self.workerRunning) return;
    self.workerRunning = true;

    var processNext = function () {
      var msg = self.inQueue && self.inQueue.shift();

      if (!msg) {
        self.workerRunning = false;
        return;
      }

      Fiber(function () {
        var blocked = true;

        var unblock = function () {
          if (!blocked) return; // idempotent

          blocked = false;
          processNext();
        };

        self.server.onMessageHook.each(function (callback) {
          callback(msg, self);
          return true;
        });
        if (_.has(self.protocol_handlers, msg.msg)) self.protocol_handlers[msg.msg].call(self, msg, unblock);else self.sendError('Bad request', msg);
        unblock(); // in case the handler didn't already do it
      }).run();
    };

    processNext();
  },
  protocol_handlers: {
    sub: function (msg, unblock) {
      var self = this; // cacheUnblock temporarly, so we can capture it later
      // we will use unblock in current eventLoop, so this is safe

      self.cachedUnblock = unblock; // reject malformed messages

      if (typeof msg.id !== "string" || typeof msg.name !== "string" || 'params' in msg && !(msg.params instanceof Array)) {
        self.sendError("Malformed subscription", msg);
        return;
      }

      if (!self.server.publish_handlers[msg.name]) {
        self.send({
          msg: 'nosub',
          id: msg.id,
          error: new Meteor.Error(404, "Subscription '".concat(msg.name, "' not found"))
        });
        return;
      }

      if (self._namedSubs.has(msg.id)) // subs are idempotent, or rather, they are ignored if a sub
        // with that id already exists. this is important during
        // reconnect.
        return; // XXX It'd be much better if we had generic hooks where any package can
      // hook into subscription handling, but in the mean while we special case
      // ddp-rate-limiter package. This is also done for weak requirements to
      // add the ddp-rate-limiter package in case we don't have Accounts. A
      // user trying to use the ddp-rate-limiter must explicitly require it.

      if (Package['ddp-rate-limiter']) {
        var DDPRateLimiter = Package['ddp-rate-limiter'].DDPRateLimiter;
        var rateLimiterInput = {
          userId: self.userId,
          clientAddress: self.connectionHandle.clientAddress,
          type: "subscription",
          name: msg.name,
          connectionId: self.id
        };

        DDPRateLimiter._increment(rateLimiterInput);

        var rateLimitResult = DDPRateLimiter._check(rateLimiterInput);

        if (!rateLimitResult.allowed) {
          self.send({
            msg: 'nosub',
            id: msg.id,
            error: new Meteor.Error('too-many-requests', DDPRateLimiter.getErrorMessage(rateLimitResult), {
              timeToReset: rateLimitResult.timeToReset
            })
          });
          return;
        }
      }

      var handler = self.server.publish_handlers[msg.name];

      self._startSubscription(handler, msg.id, msg.params, msg.name); // cleaning cached unblock


      self.cachedUnblock = null;
    },
    unsub: function (msg) {
      var self = this;

      self._stopSubscription(msg.id);
    },
    method: function (msg, unblock) {
      var self = this; // Reject malformed messages.
      // For now, we silently ignore unknown attributes,
      // for forwards compatibility.

      if (typeof msg.id !== "string" || typeof msg.method !== "string" || 'params' in msg && !(msg.params instanceof Array) || 'randomSeed' in msg && typeof msg.randomSeed !== "string") {
        self.sendError("Malformed method invocation", msg);
        return;
      }

      var randomSeed = msg.randomSeed || null; // Set up to mark the method as satisfied once all observers
      // (and subscriptions) have reacted to any writes that were
      // done.

      var fence = new DDPServer._WriteFence();
      fence.onAllCommitted(function () {
        // Retire the fence so that future writes are allowed.
        // This means that callbacks like timers are free to use
        // the fence, and if they fire before it's armed (for
        // example, because the method waits for them) their
        // writes will be included in the fence.
        fence.retire();
        self.send({
          msg: 'updated',
          methods: [msg.id]
        });
      }); // Find the handler

      var handler = self.server.method_handlers[msg.method];

      if (!handler) {
        self.send({
          msg: 'result',
          id: msg.id,
          error: new Meteor.Error(404, "Method '".concat(msg.method, "' not found"))
        });
        fence.arm();
        return;
      }

      var setUserId = function (userId) {
        self._setUserId(userId);
      };

      var invocation = new DDPCommon.MethodInvocation({
        isSimulation: false,
        userId: self.userId,
        setUserId: setUserId,
        unblock: unblock,
        connection: self.connectionHandle,
        randomSeed: randomSeed
      });
      const promise = new Promise((resolve, reject) => {
        // XXX It'd be better if we could hook into method handlers better but
        // for now, we need to check if the ddp-rate-limiter exists since we
        // have a weak requirement for the ddp-rate-limiter package to be added
        // to our application.
        if (Package['ddp-rate-limiter']) {
          var DDPRateLimiter = Package['ddp-rate-limiter'].DDPRateLimiter;
          var rateLimiterInput = {
            userId: self.userId,
            clientAddress: self.connectionHandle.clientAddress,
            type: "method",
            name: msg.method,
            connectionId: self.id
          };

          DDPRateLimiter._increment(rateLimiterInput);

          var rateLimitResult = DDPRateLimiter._check(rateLimiterInput);

          if (!rateLimitResult.allowed) {
            reject(new Meteor.Error("too-many-requests", DDPRateLimiter.getErrorMessage(rateLimitResult), {
              timeToReset: rateLimitResult.timeToReset
            }));
            return;
          }
        }

        const getCurrentMethodInvocationResult = () => {
          const currentContext = DDP._CurrentMethodInvocation._setNewContextAndGetCurrent(invocation);

          try {
            let result;
            const resultOrThenable = maybeAuditArgumentChecks(handler, invocation, msg.params, "call to '" + msg.method + "'");
            const isThenable = resultOrThenable && typeof resultOrThenable.then === 'function';

            if (isThenable) {
              result = Promise.await(resultOrThenable);
            } else {
              result = resultOrThenable;
            }

            return result;
          } finally {
            DDP._CurrentMethodInvocation._set(currentContext);
          }
        };

        resolve(DDPServer._CurrentWriteFence.withValue(fence, getCurrentMethodInvocationResult));
      });

      function finish() {
        fence.arm();
        unblock();
      }

      const payload = {
        msg: "result",
        id: msg.id
      };
      promise.then(result => {
        finish();

        if (result !== undefined) {
          payload.result = result;
        }

        self.send(payload);
      }, exception => {
        finish();
        payload.error = wrapInternalException(exception, "while invoking method '".concat(msg.method, "'"));
        self.send(payload);
      });
    }
  },
  _eachSub: function (f) {
    var self = this;

    self._namedSubs.forEach(f);

    self._universalSubs.forEach(f);
  },
  _diffCollectionViews: function (beforeCVs) {
    var self = this;
    DiffSequence.diffMaps(beforeCVs, self.collectionViews, {
      both: function (collectionName, leftValue, rightValue) {
        rightValue.diff(leftValue);
      },
      rightOnly: function (collectionName, rightValue) {
        rightValue.documents.forEach(function (docView, id) {
          self.sendAdded(collectionName, id, docView.getFields());
        });
      },
      leftOnly: function (collectionName, leftValue) {
        leftValue.documents.forEach(function (doc, id) {
          self.sendRemoved(collectionName, id);
        });
      }
    });
  },
  // Sets the current user id in all appropriate contexts and reruns
  // all subscriptions
  _setUserId: function (userId) {
    var self = this;
    if (userId !== null && typeof userId !== "string") throw new Error("setUserId must be called on string or null, not " + typeof userId); // Prevent newly-created universal subscriptions from being added to our
    // session. They will be found below when we call startUniversalSubs.
    //
    // (We don't have to worry about named subscriptions, because we only add
    // them when we process a 'sub' message. We are currently processing a
    // 'method' message, and the method did not unblock, because it is illegal
    // to call setUserId after unblock. Thus we cannot be concurrently adding a
    // new named subscription).

    self._dontStartNewUniversalSubs = true; // Prevent current subs from updating our collectionViews and call their
    // stop callbacks. This may yield.

    self._eachSub(function (sub) {
      sub._deactivate();
    }); // All subs should now be deactivated. Stop sending messages to the client,
    // save the state of the published collections, reset to an empty view, and
    // update the userId.


    self._isSending = false;
    var beforeCVs = self.collectionViews;
    self.collectionViews = new Map();
    self.userId = userId; // _setUserId is normally called from a Meteor method with
    // DDP._CurrentMethodInvocation set. But DDP._CurrentMethodInvocation is not
    // expected to be set inside a publish function, so we temporary unset it.
    // Inside a publish function DDP._CurrentPublicationInvocation is set.

    DDP._CurrentMethodInvocation.withValue(undefined, function () {
      // Save the old named subs, and reset to having no subscriptions.
      var oldNamedSubs = self._namedSubs;
      self._namedSubs = new Map();
      self._universalSubs = [];
      oldNamedSubs.forEach(function (sub, subscriptionId) {
        var newSub = sub._recreate();

        self._namedSubs.set(subscriptionId, newSub); // nb: if the handler throws or calls this.error(), it will in fact
        // immediately send its 'nosub'. This is OK, though.


        newSub._runHandler();
      }); // Allow newly-created universal subs to be started on our connection in
      // parallel with the ones we're spinning up here, and spin up universal
      // subs.

      self._dontStartNewUniversalSubs = false;
      self.startUniversalSubs();
    }); // Start sending messages again, beginning with the diff from the previous
    // state of the world to the current state. No yields are allowed during
    // this diff, so that other changes cannot interleave.


    Meteor._noYieldsAllowed(function () {
      self._isSending = true;

      self._diffCollectionViews(beforeCVs);

      if (!_.isEmpty(self._pendingReady)) {
        self.sendReady(self._pendingReady);
        self._pendingReady = [];
      }
    });
  },
  _startSubscription: function (handler, subId, params, name) {
    var self = this;
    var sub = new Subscription(self, handler, subId, params, name);
    let unblockHander = self.cachedUnblock; // _startSubscription may call from a lot places
    // so cachedUnblock might be null in somecases
    // assign the cachedUnblock

    sub.unblock = unblockHander || (() => {});

    if (subId) self._namedSubs.set(subId, sub);else self._universalSubs.push(sub);

    sub._runHandler();
  },
  // Tear down specified subscription
  _stopSubscription: function (subId, error) {
    var self = this;
    var subName = null;

    if (subId) {
      var maybeSub = self._namedSubs.get(subId);

      if (maybeSub) {
        subName = maybeSub._name;

        maybeSub._removeAllDocuments();

        maybeSub._deactivate();

        self._namedSubs.delete(subId);
      }
    }

    var response = {
      msg: 'nosub',
      id: subId
    };

    if (error) {
      response.error = wrapInternalException(error, subName ? "from sub " + subName + " id " + subId : "from sub id " + subId);
    }

    self.send(response);
  },
  // Tear down all subscriptions. Note that this does NOT send removed or nosub
  // messages, since we assume the client is gone.
  _deactivateAllSubscriptions: function () {
    var self = this;

    self._namedSubs.forEach(function (sub, id) {
      sub._deactivate();
    });

    self._namedSubs = new Map();

    self._universalSubs.forEach(function (sub) {
      sub._deactivate();
    });

    self._universalSubs = [];
  },
  // Determine the remote client's IP address, based on the
  // HTTP_FORWARDED_COUNT environment variable representing how many
  // proxies the server is behind.
  _clientAddress: function () {
    var self = this; // For the reported client address for a connection to be correct,
    // the developer must set the HTTP_FORWARDED_COUNT environment
    // variable to an integer representing the number of hops they
    // expect in the `x-forwarded-for` header. E.g., set to "1" if the
    // server is behind one proxy.
    //
    // This could be computed once at startup instead of every time.

    var httpForwardedCount = parseInt(process.env['HTTP_FORWARDED_COUNT']) || 0;
    if (httpForwardedCount === 0) return self.socket.remoteAddress;
    var forwardedFor = self.socket.headers["x-forwarded-for"];
    if (!_.isString(forwardedFor)) return null;
    forwardedFor = forwardedFor.trim().split(/\s*,\s*/); // Typically the first value in the `x-forwarded-for` header is
    // the original IP address of the client connecting to the first
    // proxy.  However, the end user can easily spoof the header, in
    // which case the first value(s) will be the fake IP address from
    // the user pretending to be a proxy reporting the original IP
    // address value.  By counting HTTP_FORWARDED_COUNT back from the
    // end of the list, we ensure that we get the IP address being
    // reported by *our* first proxy.

    if (httpForwardedCount < 0 || httpForwardedCount > forwardedFor.length) return null;
    return forwardedFor[forwardedFor.length - httpForwardedCount];
  }
});
/******************************************************************************/

/* Subscription                                                               */

/******************************************************************************/
// Ctor for a sub handle: the input to each publish function
// Instance name is this because it's usually referred to as this inside a
// publish

/**
 * @summary The server's side of a subscription
 * @class Subscription
 * @instanceName this
 * @showInstanceName true
 */

var Subscription = function (session, handler, subscriptionId, params, name) {
  var self = this;
  self._session = session; // type is Session

  /**
   * @summary Access inside the publish function. The incoming [connection](#meteor_onconnection) for this subscription.
   * @locus Server
   * @name  connection
   * @memberOf Subscription
   * @instance
   */

  self.connection = session.connectionHandle; // public API object

  self._handler = handler; // My subscription ID (generated by client, undefined for universal subs).

  self._subscriptionId = subscriptionId; // Undefined for universal subs

  self._name = name;
  self._params = params || []; // Only named subscriptions have IDs, but we need some sort of string
  // internally to keep track of all subscriptions inside
  // SessionDocumentViews. We use this subscriptionHandle for that.

  if (self._subscriptionId) {
    self._subscriptionHandle = 'N' + self._subscriptionId;
  } else {
    self._subscriptionHandle = 'U' + Random.id();
  } // Has _deactivate been called?


  self._deactivated = false; // Stop callbacks to g/c this sub.  called w/ zero arguments.

  self._stopCallbacks = []; // The set of (collection, documentid) that this subscription has
  // an opinion about.

  self._documents = new Map(); // Remember if we are ready.

  self._ready = false; // Part of the public API: the user of this sub.

  /**
   * @summary Access inside the publish function. The id of the logged-in user, or `null` if no user is logged in.
   * @locus Server
   * @memberOf Subscription
   * @name  userId
   * @instance
   */

  self.userId = session.userId; // For now, the id filter is going to default to
  // the to/from DDP methods on MongoID, to
  // specifically deal with mongo/minimongo ObjectIds.
  // Later, you will be able to make this be "raw"
  // if you want to publish a collection that you know
  // just has strings for keys and no funny business, to
  // a DDP consumer that isn't minimongo.

  self._idFilter = {
    idStringify: MongoID.idStringify,
    idParse: MongoID.idParse
  };
  Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("livedata", "subscriptions", 1);
};

Object.assign(Subscription.prototype, {
  _runHandler: function () {
    // XXX should we unblock() here? Either before running the publish
    // function, or before running _publishCursor.
    //
    // Right now, each publish function blocks all future publishes and
    // methods waiting on data from Mongo (or whatever else the function
    // blocks on). This probably slows page load in common cases.
    if (!this.unblock) {
      this.unblock = () => {};
    }

    const self = this;
    let resultOrThenable = null;

    try {
      resultOrThenable = DDP._CurrentPublicationInvocation.withValue(self, () => maybeAuditArgumentChecks(self._handler, self, EJSON.clone(self._params), // It's OK that this would look weird for universal subscriptions,
      // because they have no arguments so there can never be an
      // audit-argument-checks failure.
      "publisher '" + self._name + "'"));
    } catch (e) {
      self.error(e);
      return;
    } // Did the handler call this.error or this.stop?


    if (self._isDeactivated()) return; // Both conventional and async publish handler functions are supported.
    // If an object is returned with a then() function, it is either a promise
    // or thenable and will be resolved asynchronously.

    const isThenable = resultOrThenable && typeof resultOrThenable.then === 'function';

    if (isThenable) {
      Promise.resolve(resultOrThenable).then(function () {
        return self._publishHandlerResult.bind(self)(...arguments);
      }, e => self.error(e));
    } else {
      self._publishHandlerResult(resultOrThenable);
    }
  },
  _publishHandlerResult: function (res) {
    // SPECIAL CASE: Instead of writing their own callbacks that invoke
    // this.added/changed/ready/etc, the user can just return a collection
    // cursor or array of cursors from the publish function; we call their
    // _publishCursor method which starts observing the cursor and publishes the
    // results. Note that _publishCursor does NOT call ready().
    //
    // XXX This uses an undocumented interface which only the Mongo cursor
    // interface publishes. Should we make this interface public and encourage
    // users to implement it themselves? Arguably, it's unnecessary; users can
    // already write their own functions like
    //   var publishMyReactiveThingy = function (name, handler) {
    //     Meteor.publish(name, function () {
    //       var reactiveThingy = handler();
    //       reactiveThingy.publishMe();
    //     });
    //   };
    var self = this;

    var isCursor = function (c) {
      return c && c._publishCursor;
    };

    if (isCursor(res)) {
      try {
        res._publishCursor(self);
      } catch (e) {
        self.error(e);
        return;
      } // _publishCursor only returns after the initial added callbacks have run.
      // mark subscription as ready.


      self.ready();
    } else if (_.isArray(res)) {
      // Check all the elements are cursors
      if (!_.all(res, isCursor)) {
        self.error(new Error("Publish function returned an array of non-Cursors"));
        return;
      } // Find duplicate collection names
      // XXX we should support overlapping cursors, but that would require the
      // merge box to allow overlap within a subscription


      var collectionNames = {};

      for (var i = 0; i < res.length; ++i) {
        var collectionName = res[i]._getCollectionName();

        if (_.has(collectionNames, collectionName)) {
          self.error(new Error("Publish function returned multiple cursors for collection " + collectionName));
          return;
        }

        collectionNames[collectionName] = true;
      }

      ;

      try {
        _.each(res, function (cur) {
          cur._publishCursor(self);
        });
      } catch (e) {
        self.error(e);
        return;
      }

      self.ready();
    } else if (res) {
      // Truthy values other than cursors or arrays are probably a
      // user mistake (possible returning a Mongo document via, say,
      // `coll.findOne()`).
      self.error(new Error("Publish function can only return a Cursor or " + "an array of Cursors"));
    }
  },
  // This calls all stop callbacks and prevents the handler from updating any
  // SessionCollectionViews further. It's used when the user unsubscribes or
  // disconnects, as well as during setUserId re-runs. It does *NOT* send
  // removed messages for the published objects; if that is necessary, call
  // _removeAllDocuments first.
  _deactivate: function () {
    var self = this;
    if (self._deactivated) return;
    self._deactivated = true;

    self._callStopCallbacks();

    Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("livedata", "subscriptions", -1);
  },
  _callStopCallbacks: function () {
    var self = this; // Tell listeners, so they can clean up

    var callbacks = self._stopCallbacks;
    self._stopCallbacks = [];

    _.each(callbacks, function (callback) {
      callback();
    });
  },
  // Send remove messages for every document.
  _removeAllDocuments: function () {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._documents.forEach(function (collectionDocs, collectionName) {
        collectionDocs.forEach(function (strId) {
          self.removed(collectionName, self._idFilter.idParse(strId));
        });
      });
    });
  },
  // Returns a new Subscription for the same session with the same
  // initial creation parameters. This isn't a clone: it doesn't have
  // the same _documents cache, stopped state or callbacks; may have a
  // different _subscriptionHandle, and gets its userId from the
  // session, not from this object.
  _recreate: function () {
    var self = this;
    return new Subscription(self._session, self._handler, self._subscriptionId, self._params, self._name);
  },

  /**
   * @summary Call inside the publish function.  Stops this client's subscription, triggering a call on the client to the `onStop` callback passed to [`Meteor.subscribe`](#meteor_subscribe), if any. If `error` is not a [`Meteor.Error`](#meteor_error), it will be [sanitized](#meteor_error).
   * @locus Server
   * @param {Error} error The error to pass to the client.
   * @instance
   * @memberOf Subscription
   */
  error: function (error) {
    var self = this;
    if (self._isDeactivated()) return;

    self._session._stopSubscription(self._subscriptionId, error);
  },
  // Note that while our DDP client will notice that you've called stop() on the
  // server (and clean up its _subscriptions table) we don't actually provide a
  // mechanism for an app to notice this (the subscribe onError callback only
  // triggers if there is an error).

  /**
   * @summary Call inside the publish function.  Stops this client's subscription and invokes the client's `onStop` callback with no error.
   * @locus Server
   * @instance
   * @memberOf Subscription
   */
  stop: function () {
    var self = this;
    if (self._isDeactivated()) return;

    self._session._stopSubscription(self._subscriptionId);
  },

  /**
   * @summary Call inside the publish function.  Registers a callback function to run when the subscription is stopped.
   * @locus Server
   * @memberOf Subscription
   * @instance
   * @param {Function} func The callback function
   */
  onStop: function (callback) {
    var self = this;
    callback = Meteor.bindEnvironment(callback, 'onStop callback', self);
    if (self._isDeactivated()) callback();else self._stopCallbacks.push(callback);
  },
  // This returns true if the sub has been deactivated, *OR* if the session was
  // destroyed but the deferred call to _deactivateAllSubscriptions hasn't
  // happened yet.
  _isDeactivated: function () {
    var self = this;
    return self._deactivated || self._session.inQueue === null;
  },

  /**
   * @summary Call inside the publish function.  Informs the subscriber that a document has been added to the record set.
   * @locus Server
   * @memberOf Subscription
   * @instance
   * @param {String} collection The name of the collection that contains the new document.
   * @param {String} id The new document's ID.
   * @param {Object} fields The fields in the new document.  If `_id` is present it is ignored.
   */
  added(collectionName, id, fields) {
    if (this._isDeactivated()) return;
    id = this._idFilter.idStringify(id);

    if (this._session.server.getPublicationStrategy(collectionName).doAccountingForCollection) {
      let ids = this._documents.get(collectionName);

      if (ids == null) {
        ids = new Set();

        this._documents.set(collectionName, ids);
      }

      ids.add(id);
    }

    this._session.added(this._subscriptionHandle, collectionName, id, fields);
  },

  /**
   * @summary Call inside the publish function.  Informs the subscriber that a document in the record set has been modified.
   * @locus Server
   * @memberOf Subscription
   * @instance
   * @param {String} collection The name of the collection that contains the changed document.
   * @param {String} id The changed document's ID.
   * @param {Object} fields The fields in the document that have changed, together with their new values.  If a field is not present in `fields` it was left unchanged; if it is present in `fields` and has a value of `undefined` it was removed from the document.  If `_id` is present it is ignored.
   */
  changed(collectionName, id, fields) {
    if (this._isDeactivated()) return;
    id = this._idFilter.idStringify(id);

    this._session.changed(this._subscriptionHandle, collectionName, id, fields);
  },

  /**
   * @summary Call inside the publish function.  Informs the subscriber that a document has been removed from the record set.
   * @locus Server
   * @memberOf Subscription
   * @instance
   * @param {String} collection The name of the collection that the document has been removed from.
   * @param {String} id The ID of the document that has been removed.
   */
  removed(collectionName, id) {
    if (this._isDeactivated()) return;
    id = this._idFilter.idStringify(id);

    if (this._session.server.getPublicationStrategy(collectionName).doAccountingForCollection) {
      // We don't bother to delete sets of things in a collection if the
      // collection is empty.  It could break _removeAllDocuments.
      this._documents.get(collectionName).delete(id);
    }

    this._session.removed(this._subscriptionHandle, collectionName, id);
  },

  /**
   * @summary Call inside the publish function.  Informs the subscriber that an initial, complete snapshot of the record set has been sent.  This will trigger a call on the client to the `onReady` callback passed to  [`Meteor.subscribe`](#meteor_subscribe), if any.
   * @locus Server
   * @memberOf Subscription
   * @instance
   */
  ready: function () {
    var self = this;
    if (self._isDeactivated()) return;
    if (!self._subscriptionId) return; // Unnecessary but ignored for universal sub

    if (!self._ready) {
      self._session.sendReady([self._subscriptionId]);

      self._ready = true;
    }
  }
});
/******************************************************************************/

/* Server                                                                     */

/******************************************************************************/

Server = function () {
  let options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};
  var self = this; // The default heartbeat interval is 30 seconds on the server and 35
  // seconds on the client.  Since the client doesn't need to send a
  // ping as long as it is receiving pings, this means that pings
  // normally go from the server to the client.
  //
  // Note: Troposphere depends on the ability to mutate
  // Meteor.server.options.heartbeatTimeout! This is a hack, but it's life.

  self.options = _objectSpread({
    heartbeatInterval: 15000,
    heartbeatTimeout: 15000,
    // For testing, allow responding to pings to be disabled.
    respondToPings: true,
    defaultPublicationStrategy: publicationStrategies.SERVER_MERGE
  }, options); // Map of callbacks to call when a new connection comes in to the
  // server and completes DDP version negotiation. Use an object instead
  // of an array so we can safely remove one from the list while
  // iterating over it.

  self.onConnectionHook = new Hook({
    debugPrintExceptions: "onConnection callback"
  }); // Map of callbacks to call when a new message comes in.

  self.onMessageHook = new Hook({
    debugPrintExceptions: "onMessage callback"
  });
  self.publish_handlers = {};
  self.universal_publish_handlers = [];
  self.method_handlers = {};
  self._publicationStrategies = {};
  self.sessions = new Map(); // map from id to session

  self.stream_server = new StreamServer();
  self.stream_server.register(function (socket) {
    // socket implements the SockJSConnection interface
    socket._meteorSession = null;

    var sendError = function (reason, offendingMessage) {
      var msg = {
        msg: 'error',
        reason: reason
      };
      if (offendingMessage) msg.offendingMessage = offendingMessage;
      socket.send(DDPCommon.stringifyDDP(msg));
    };

    socket.on('data', function (raw_msg) {
      if (Meteor._printReceivedDDP) {
        Meteor._debug("Received DDP", raw_msg);
      }

      try {
        try {
          var msg = DDPCommon.parseDDP(raw_msg);
        } catch (err) {
          sendError('Parse error');
          return;
        }

        if (msg === null || !msg.msg) {
          sendError('Bad request', msg);
          return;
        }

        if (msg.msg === 'connect') {
          if (socket._meteorSession) {
            sendError("Already connected", msg);
            return;
          }

          Fiber(function () {
            self._handleConnect(socket, msg);
          }).run();
          return;
        }

        if (!socket._meteorSession) {
          sendError('Must connect first', msg);
          return;
        }

        socket._meteorSession.processMessage(msg);
      } catch (e) {
        // XXX print stack nicely
        Meteor._debug("Internal exception while processing message", msg, e);
      }
    });
    socket.on('close', function () {
      if (socket._meteorSession) {
        Fiber(function () {
          socket._meteorSession.close();
        }).run();
      }
    });
  });
};

Object.assign(Server.prototype, {
  /**
   * @summary Register a callback to be called when a new DDP connection is made to the server.
   * @locus Server
   * @param {function} callback The function to call when a new DDP connection is established.
   * @memberOf Meteor
   * @importFromPackage meteor
   */
  onConnection: function (fn) {
    var self = this;
    return self.onConnectionHook.register(fn);
  },

  /**
   * @summary Set publication strategy for the given collection. Publications strategies are available from `DDPServer.publicationStrategies`. You call this method from `Meteor.server`, like `Meteor.server.setPublicationStrategy()`
   * @locus Server
   * @alias setPublicationStrategy
   * @param collectionName {String}
   * @param strategy {{useCollectionView: boolean, doAccountingForCollection: boolean}}
   * @memberOf Meteor.server
   * @importFromPackage meteor
   */
  setPublicationStrategy(collectionName, strategy) {
    if (!Object.values(publicationStrategies).includes(strategy)) {
      throw new Error("Invalid merge strategy: ".concat(strategy, " \n        for collection ").concat(collectionName));
    }

    this._publicationStrategies[collectionName] = strategy;
  },

  /**
   * @summary Gets the publication strategy for the requested collection. You call this method from `Meteor.server`, like `Meteor.server.getPublicationStrategy()`
   * @locus Server
   * @alias getPublicationStrategy
   * @param collectionName {String}
   * @memberOf Meteor.server
   * @importFromPackage meteor
   * @return {{useCollectionView: boolean, doAccountingForCollection: boolean}}
   */
  getPublicationStrategy(collectionName) {
    return this._publicationStrategies[collectionName] || this.options.defaultPublicationStrategy;
  },

  /**
   * @summary Register a callback to be called when a new DDP message is received.
   * @locus Server
   * @param {function} callback The function to call when a new DDP message is received.
   * @memberOf Meteor
   * @importFromPackage meteor
   */
  onMessage: function (fn) {
    var self = this;
    return self.onMessageHook.register(fn);
  },
  _handleConnect: function (socket, msg) {
    var self = this; // The connect message must specify a version and an array of supported
    // versions, and it must claim to support what it is proposing.

    if (!(typeof msg.version === 'string' && _.isArray(msg.support) && _.all(msg.support, _.isString) && _.contains(msg.support, msg.version))) {
      socket.send(DDPCommon.stringifyDDP({
        msg: 'failed',
        version: DDPCommon.SUPPORTED_DDP_VERSIONS[0]
      }));
      socket.close();
      return;
    } // In the future, handle session resumption: something like:
    //  socket._meteorSession = self.sessions[msg.session]


    var version = calculateVersion(msg.support, DDPCommon.SUPPORTED_DDP_VERSIONS);

    if (msg.version !== version) {
      // The best version to use (according to the client's stated preferences)
      // is not the one the client is trying to use. Inform them about the best
      // version to use.
      socket.send(DDPCommon.stringifyDDP({
        msg: 'failed',
        version: version
      }));
      socket.close();
      return;
    } // Yay, version matches! Create a new session.
    // Note: Troposphere depends on the ability to mutate
    // Meteor.server.options.heartbeatTimeout! This is a hack, but it's life.


    socket._meteorSession = new Session(self, version, socket, self.options);
    self.sessions.set(socket._meteorSession.id, socket._meteorSession);
    self.onConnectionHook.each(function (callback) {
      if (socket._meteorSession) callback(socket._meteorSession.connectionHandle);
      return true;
    });
  },

  /**
   * Register a publish handler function.
   *
   * @param name {String} identifier for query
   * @param handler {Function} publish handler
   * @param options {Object}
   *
   * Server will call handler function on each new subscription,
   * either when receiving DDP sub message for a named subscription, or on
   * DDP connect for a universal subscription.
   *
   * If name is null, this will be a subscription that is
   * automatically established and permanently on for all connected
   * client, instead of a subscription that can be turned on and off
   * with subscribe().
   *
   * options to contain:
   *  - (mostly internal) is_auto: true if generated automatically
   *    from an autopublish hook. this is for cosmetic purposes only
   *    (it lets us determine whether to print a warning suggesting
   *    that you turn off autopublish).
   */

  /**
   * @summary Publish a record set.
   * @memberOf Meteor
   * @importFromPackage meteor
   * @locus Server
   * @param {String|Object} name If String, name of the record set.  If Object, publications Dictionary of publish functions by name.  If `null`, the set has no name, and the record set is automatically sent to all connected clients.
   * @param {Function} func Function called on the server each time a client subscribes.  Inside the function, `this` is the publish handler object, described below.  If the client passed arguments to `subscribe`, the function is called with the same arguments.
   */
  publish: function (name, handler, options) {
    var self = this;

    if (!_.isObject(name)) {
      options = options || {};

      if (name && name in self.publish_handlers) {
        Meteor._debug("Ignoring duplicate publish named '" + name + "'");

        return;
      }

      if (Package.autopublish && !options.is_auto) {
        // They have autopublish on, yet they're trying to manually
        // pick stuff to publish. They probably should turn off
        // autopublish. (This check isn't perfect -- if you create a
        // publish before you turn on autopublish, it won't catch
        // it, but this will definitely handle the simple case where
        // you've added the autopublish package to your app, and are
        // calling publish from your app code).
        if (!self.warned_about_autopublish) {
          self.warned_about_autopublish = true;

          Meteor._debug("** You've set up some data subscriptions with Meteor.publish(), but\n" + "** you still have autopublish turned on. Because autopublish is still\n" + "** on, your Meteor.publish() calls won't have much effect. All data\n" + "** will still be sent to all clients.\n" + "**\n" + "** Turn off autopublish by removing the autopublish package:\n" + "**\n" + "**   $ meteor remove autopublish\n" + "**\n" + "** .. and make sure you have Meteor.publish() and Meteor.subscribe() calls\n" + "** for each collection that you want clients to see.\n");
        }
      }

      if (name) self.publish_handlers[name] = handler;else {
        self.universal_publish_handlers.push(handler); // Spin up the new publisher on any existing session too. Run each
        // session's subscription in a new Fiber, so that there's no change for
        // self.sessions to change while we're running this loop.

        self.sessions.forEach(function (session) {
          if (!session._dontStartNewUniversalSubs) {
            Fiber(function () {
              session._startSubscription(handler);
            }).run();
          }
        });
      }
    } else {
      _.each(name, function (value, key) {
        self.publish(key, value, {});
      });
    }
  },
  _removeSession: function (session) {
    var self = this;
    self.sessions.delete(session.id);
  },

  /**
   * @summary Defines functions that can be invoked over the network by clients.
   * @locus Anywhere
   * @param {Object} methods Dictionary whose keys are method names and values are functions.
   * @memberOf Meteor
   * @importFromPackage meteor
   */
  methods: function (methods) {
    var self = this;

    _.each(methods, function (func, name) {
      if (typeof func !== 'function') throw new Error("Method '" + name + "' must be a function");
      if (self.method_handlers[name]) throw new Error("A method named '" + name + "' is already defined");
      self.method_handlers[name] = func;
    });
  },
  call: function (name) {
    for (var _len = arguments.length, args = new Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
      args[_key - 1] = arguments[_key];
    }

    if (args.length && typeof args[args.length - 1] === "function") {
      // If it's a function, the last argument is the result callback, not
      // a parameter to the remote method.
      var callback = args.pop();
    }

    return this.apply(name, args, callback);
  },
  // A version of the call method that always returns a Promise.
  callAsync: function (name) {
    for (var _len2 = arguments.length, args = new Array(_len2 > 1 ? _len2 - 1 : 0), _key2 = 1; _key2 < _len2; _key2++) {
      args[_key2 - 1] = arguments[_key2];
    }

    return this.applyAsync(name, args);
  },
  apply: function (name, args, options, callback) {
    // We were passed 3 arguments. They may be either (name, args, options)
    // or (name, args, callback)
    if (!callback && typeof options === 'function') {
      callback = options;
      options = {};
    } else {
      options = options || {};
    }

    const promise = this.applyAsync(name, args, options); // Return the result in whichever way the caller asked for it. Note that we
    // do NOT block on the write fence in an analogous way to how the client
    // blocks on the relevant data being visible, so you are NOT guaranteed that
    // cursor observe callbacks have fired when your callback is invoked. (We
    // can change this if there's a real use case).

    if (callback) {
      promise.then(result => callback(undefined, result), exception => callback(exception));
    } else {
      return promise.await();
    }
  },
  // @param options {Optional Object}
  applyAsync: function (name, args, options) {
    // Run the handler
    var handler = this.method_handlers[name];

    if (!handler) {
      return Promise.reject(new Meteor.Error(404, "Method '".concat(name, "' not found")));
    } // If this is a method call from within another method or publish function,
    // get the user state from the outer method or publish function, otherwise
    // don't allow setUserId to be called


    var userId = null;

    var setUserId = function () {
      throw new Error("Can't call setUserId on a server initiated method call");
    };

    var connection = null;

    var currentMethodInvocation = DDP._CurrentMethodInvocation.get();

    var currentPublicationInvocation = DDP._CurrentPublicationInvocation.get();

    var randomSeed = null;

    if (currentMethodInvocation) {
      userId = currentMethodInvocation.userId;

      setUserId = function (userId) {
        currentMethodInvocation.setUserId(userId);
      };

      connection = currentMethodInvocation.connection;
      randomSeed = DDPCommon.makeRpcSeed(currentMethodInvocation, name);
    } else if (currentPublicationInvocation) {
      userId = currentPublicationInvocation.userId;

      setUserId = function (userId) {
        currentPublicationInvocation._session._setUserId(userId);
      };

      connection = currentPublicationInvocation.connection;
    }

    var invocation = new DDPCommon.MethodInvocation({
      isSimulation: false,
      userId,
      setUserId,
      connection,
      randomSeed
    });
    return new Promise(resolve => resolve(DDP._CurrentMethodInvocation.withValue(invocation, () => maybeAuditArgumentChecks(handler, invocation, EJSON.clone(args), "internal call to '" + name + "'")))).then(EJSON.clone);
  },
  _urlForSession: function (sessionId) {
    var self = this;
    var session = self.sessions.get(sessionId);
    if (session) return session._socketUrl;else return null;
  }
});

var calculateVersion = function (clientSupportedVersions, serverSupportedVersions) {
  var correctVersion = _.find(clientSupportedVersions, function (version) {
    return _.contains(serverSupportedVersions, version);
  });

  if (!correctVersion) {
    correctVersion = serverSupportedVersions[0];
  }

  return correctVersion;
};

DDPServer._calculateVersion = calculateVersion; // "blind" exceptions other than those that were deliberately thrown to signal
// errors to the client

var wrapInternalException = function (exception, context) {
  if (!exception) return exception; // To allow packages to throw errors intended for the client but not have to
  // depend on the Meteor.Error class, `isClientSafe` can be set to true on any
  // error before it is thrown.

  if (exception.isClientSafe) {
    if (!(exception instanceof Meteor.Error)) {
      const originalMessage = exception.message;
      exception = new Meteor.Error(exception.error, exception.reason, exception.details);
      exception.message = originalMessage;
    }

    return exception;
  } // Tests can set the '_expectedByTest' flag on an exception so it won't go to
  // the server log.


  if (!exception._expectedByTest) {
    Meteor._debug("Exception " + context, exception.stack);

    if (exception.sanitizedError) {
      Meteor._debug("Sanitized and reported to the client as:", exception.sanitizedError);

      Meteor._debug();
    }
  } // Did the error contain more details that could have been useful if caught in
  // server code (or if thrown from non-client-originated code), but also
  // provided a "sanitized" version with more context than 500 Internal server
  // error? Use that.


  if (exception.sanitizedError) {
    if (exception.sanitizedError.isClientSafe) return exception.sanitizedError;

    Meteor._debug("Exception " + context + " provides a sanitizedError that " + "does not have isClientSafe property set; ignoring");
  }

  return new Meteor.Error(500, "Internal server error");
}; // Audit argument checks, if the audit-argument-checks package exists (it is a
// weak dependency of this package).


var maybeAuditArgumentChecks = function (f, context, args, description) {
  args = args || [];

  if (Package['audit-argument-checks']) {
    return Match._failIfArgumentsAreNotAllChecked(f, context, args, description);
  }

  return f.apply(context, args);
};
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"writefence.js":function module(require){

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                    //
// packages/ddp-server/writefence.js                                                                                  //
//                                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                      //
var Future = Npm.require('fibers/future'); // A write fence collects a group of writes, and provides a callback
// when all of the writes are fully committed and propagated (all
// observers have been notified of the write and acknowledged it.)
//


DDPServer._WriteFence = function () {
  var self = this;
  self.armed = false;
  self.fired = false;
  self.retired = false;
  self.outstanding_writes = 0;
  self.before_fire_callbacks = [];
  self.completion_callbacks = [];
}; // The current write fence. When there is a current write fence, code
// that writes to databases should register their writes with it using
// beginWrite().
//


DDPServer._CurrentWriteFence = new Meteor.EnvironmentVariable();

_.extend(DDPServer._WriteFence.prototype, {
  // Start tracking a write, and return an object to represent it. The
  // object has a single method, committed(). This method should be
  // called when the write is fully committed and propagated. You can
  // continue to add writes to the WriteFence up until it is triggered
  // (calls its callbacks because all writes have committed.)
  beginWrite: function () {
    var self = this;
    if (self.retired) return {
      committed: function () {}
    };
    if (self.fired) throw new Error("fence has already activated -- too late to add writes");
    self.outstanding_writes++;
    var committed = false;
    return {
      committed: function () {
        if (committed) throw new Error("committed called twice on the same write");
        committed = true;
        self.outstanding_writes--;

        self._maybeFire();
      }
    };
  },
  // Arm the fence. Once the fence is armed, and there are no more
  // uncommitted writes, it will activate.
  arm: function () {
    var self = this;
    if (self === DDPServer._CurrentWriteFence.get()) throw Error("Can't arm the current fence");
    self.armed = true;

    self._maybeFire();
  },
  // Register a function to be called once before firing the fence.
  // Callback function can add new writes to the fence, in which case
  // it won't fire until those writes are done as well.
  onBeforeFire: function (func) {
    var self = this;
    if (self.fired) throw new Error("fence has already activated -- too late to " + "add a callback");
    self.before_fire_callbacks.push(func);
  },
  // Register a function to be called when the fence fires.
  onAllCommitted: function (func) {
    var self = this;
    if (self.fired) throw new Error("fence has already activated -- too late to " + "add a callback");
    self.completion_callbacks.push(func);
  },
  // Convenience function. Arms the fence, then blocks until it fires.
  armAndWait: function () {
    var self = this;
    var future = new Future();
    self.onAllCommitted(function () {
      future['return']();
    });
    self.arm();
    future.wait();
  },
  _maybeFire: function () {
    var self = this;
    if (self.fired) throw new Error("write fence already activated?");

    if (self.armed && !self.outstanding_writes) {
      function invokeCallback(func) {
        try {
          func(self);
        } catch (err) {
          Meteor._debug("exception in write fence callback", err);
        }
      }

      self.outstanding_writes++;

      while (self.before_fire_callbacks.length > 0) {
        var callbacks = self.before_fire_callbacks;
        self.before_fire_callbacks = [];

        _.each(callbacks, invokeCallback);
      }

      self.outstanding_writes--;

      if (!self.outstanding_writes) {
        self.fired = true;
        var callbacks = self.completion_callbacks;
        self.completion_callbacks = [];

        _.each(callbacks, invokeCallback);
      }
    }
  },
  // Deactivate this fence so that adding more writes has no effect.
  // The fence must have already fired.
  retire: function () {
    var self = this;
    if (!self.fired) throw new Error("Can't retire a fence that hasn't fired.");
    self.retired = true;
  }
});
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"crossbar.js":function module(){

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                    //
// packages/ddp-server/crossbar.js                                                                                    //
//                                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                      //
// A "crossbar" is a class that provides structured notification registration.
// See _match for the definition of how a notification matches a trigger.
// All notifications and triggers must have a string key named 'collection'.
DDPServer._Crossbar = function (options) {
  var self = this;
  options = options || {};
  self.nextId = 1; // map from collection name (string) -> listener id -> object. each object has
  // keys 'trigger', 'callback'.  As a hack, the empty string means "no
  // collection".

  self.listenersByCollection = {};
  self.listenersByCollectionCount = {};
  self.factPackage = options.factPackage || "livedata";
  self.factName = options.factName || null;
};

_.extend(DDPServer._Crossbar.prototype, {
  // msg is a trigger or a notification
  _collectionForMessage: function (msg) {
    var self = this;

    if (!_.has(msg, 'collection')) {
      return '';
    } else if (typeof msg.collection === 'string') {
      if (msg.collection === '') throw Error("Message has empty collection!");
      return msg.collection;
    } else {
      throw Error("Message has non-string collection!");
    }
  },
  // Listen for notification that match 'trigger'. A notification
  // matches if it has the key-value pairs in trigger as a
  // subset. When a notification matches, call 'callback', passing
  // the actual notification.
  //
  // Returns a listen handle, which is an object with a method
  // stop(). Call stop() to stop listening.
  //
  // XXX It should be legal to call fire() from inside a listen()
  // callback?
  listen: function (trigger, callback) {
    var self = this;
    var id = self.nextId++;

    var collection = self._collectionForMessage(trigger);

    var record = {
      trigger: EJSON.clone(trigger),
      callback: callback
    };

    if (!_.has(self.listenersByCollection, collection)) {
      self.listenersByCollection[collection] = {};
      self.listenersByCollectionCount[collection] = 0;
    }

    self.listenersByCollection[collection][id] = record;
    self.listenersByCollectionCount[collection]++;

    if (self.factName && Package['facts-base']) {
      Package['facts-base'].Facts.incrementServerFact(self.factPackage, self.factName, 1);
    }

    return {
      stop: function () {
        if (self.factName && Package['facts-base']) {
          Package['facts-base'].Facts.incrementServerFact(self.factPackage, self.factName, -1);
        }

        delete self.listenersByCollection[collection][id];
        self.listenersByCollectionCount[collection]--;

        if (self.listenersByCollectionCount[collection] === 0) {
          delete self.listenersByCollection[collection];
          delete self.listenersByCollectionCount[collection];
        }
      }
    };
  },
  // Fire the provided 'notification' (an object whose attribute
  // values are all JSON-compatibile) -- inform all matching listeners
  // (registered with listen()).
  //
  // If fire() is called inside a write fence, then each of the
  // listener callbacks will be called inside the write fence as well.
  //
  // The listeners may be invoked in parallel, rather than serially.
  fire: function (notification) {
    var self = this;

    var collection = self._collectionForMessage(notification);

    if (!_.has(self.listenersByCollection, collection)) {
      return;
    }

    var listenersForCollection = self.listenersByCollection[collection];
    var callbackIds = [];

    _.each(listenersForCollection, function (l, id) {
      if (self._matches(notification, l.trigger)) {
        callbackIds.push(id);
      }
    }); // Listener callbacks can yield, so we need to first find all the ones that
    // match in a single iteration over self.listenersByCollection (which can't
    // be mutated during this iteration), and then invoke the matching
    // callbacks, checking before each call to ensure they haven't stopped.
    // Note that we don't have to check that
    // self.listenersByCollection[collection] still === listenersForCollection,
    // because the only way that stops being true is if listenersForCollection
    // first gets reduced down to the empty object (and then never gets
    // increased again).


    _.each(callbackIds, function (id) {
      if (_.has(listenersForCollection, id)) {
        listenersForCollection[id].callback(notification);
      }
    });
  },
  // A notification matches a trigger if all keys that exist in both are equal.
  //
  // Examples:
  //  N:{collection: "C"} matches T:{collection: "C"}
  //    (a non-targeted write to a collection matches a
  //     non-targeted query)
  //  N:{collection: "C", id: "X"} matches T:{collection: "C"}
  //    (a targeted write to a collection matches a non-targeted query)
  //  N:{collection: "C"} matches T:{collection: "C", id: "X"}
  //    (a non-targeted write to a collection matches a
  //     targeted query)
  //  N:{collection: "C", id: "X"} matches T:{collection: "C", id: "X"}
  //    (a targeted write to a collection matches a targeted query targeted
  //     at the same document)
  //  N:{collection: "C", id: "X"} does not match T:{collection: "C", id: "Y"}
  //    (a targeted write to a collection does not match a targeted query
  //     targeted at a different document)
  _matches: function (notification, trigger) {
    // Most notifications that use the crossbar have a string `collection` and
    // maybe an `id` that is a string or ObjectID. We're already dividing up
    // triggers by collection, but let's fast-track "nope, different ID" (and
    // avoid the overly generic EJSON.equals). This makes a noticeable
    // performance difference; see https://github.com/meteor/meteor/pull/3697
    if (typeof notification.id === 'string' && typeof trigger.id === 'string' && notification.id !== trigger.id) {
      return false;
    }

    if (notification.id instanceof MongoID.ObjectID && trigger.id instanceof MongoID.ObjectID && !notification.id.equals(trigger.id)) {
      return false;
    }

    return _.all(trigger, function (triggerValue, key) {
      return !_.has(notification, key) || EJSON.equals(triggerValue, notification[key]);
    });
  }
}); // The "invalidation crossbar" is a specific instance used by the DDP server to
// implement write fence notifications. Listener callbacks on this crossbar
// should call beginWrite on the current write fence before they return, if they
// want to delay the write fence from firing (ie, the DDP method-data-updated
// message from being sent).


DDPServer._InvalidationCrossbar = new DDPServer._Crossbar({
  factName: "invalidation-crossbar-listeners"
});
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"server_convenience.js":function module(){

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                    //
// packages/ddp-server/server_convenience.js                                                                          //
//                                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                      //
if (process.env.DDP_DEFAULT_CONNECTION_URL) {
  __meteor_runtime_config__.DDP_DEFAULT_CONNECTION_URL = process.env.DDP_DEFAULT_CONNECTION_URL;
}

Meteor.server = new Server();

Meteor.refresh = function (notification) {
  DDPServer._InvalidationCrossbar.fire(notification);
}; // Proxy the public methods of Meteor.server so they can
// be called directly on Meteor.


_.each(['publish', 'methods', 'call', 'callAsync', 'apply', 'applyAsync', 'onConnection', 'onMessage'], function (name) {
  Meteor[name] = _.bind(Meteor.server[name], Meteor.server);
});
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}}}}},{
  "extensions": [
    ".js",
    ".json"
  ]
});

require("/node_modules/meteor/ddp-server/stream_server.js");
require("/node_modules/meteor/ddp-server/livedata_server.js");
require("/node_modules/meteor/ddp-server/writefence.js");
require("/node_modules/meteor/ddp-server/crossbar.js");
require("/node_modules/meteor/ddp-server/server_convenience.js");

/* Exports */
Package._define("ddp-server", {
  DDPServer: DDPServer
});

})();

//# sourceURL=meteor://💻app/packages/ddp-server.js
//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1ldGVvcjovL/CfkrthcHAvcGFja2FnZXMvZGRwLXNlcnZlci9zdHJlYW1fc2VydmVyLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9wYWNrYWdlcy9kZHAtc2VydmVyL2xpdmVkYXRhX3NlcnZlci5qcyIsIm1ldGVvcjovL/CfkrthcHAvcGFja2FnZXMvZGRwLXNlcnZlci93cml0ZWZlbmNlLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9wYWNrYWdlcy9kZHAtc2VydmVyL2Nyb3NzYmFyLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9wYWNrYWdlcy9kZHAtc2VydmVyL3NlcnZlcl9jb252ZW5pZW5jZS5qcyJdLCJuYW1lcyI6WyJ3ZWJzb2NrZXRFeHRlbnNpb25zIiwiXyIsIm9uY2UiLCJleHRlbnNpb25zIiwid2Vic29ja2V0Q29tcHJlc3Npb25Db25maWciLCJwcm9jZXNzIiwiZW52IiwiU0VSVkVSX1dFQlNPQ0tFVF9DT01QUkVTU0lPTiIsIkpTT04iLCJwYXJzZSIsInB1c2giLCJOcG0iLCJyZXF1aXJlIiwiY29uZmlndXJlIiwicGF0aFByZWZpeCIsIl9fbWV0ZW9yX3J1bnRpbWVfY29uZmlnX18iLCJST09UX1VSTF9QQVRIX1BSRUZJWCIsIlN0cmVhbVNlcnZlciIsInNlbGYiLCJyZWdpc3RyYXRpb25fY2FsbGJhY2tzIiwib3Blbl9zb2NrZXRzIiwicHJlZml4IiwiUm91dGVQb2xpY3kiLCJkZWNsYXJlIiwic29ja2pzIiwic2VydmVyT3B0aW9ucyIsImxvZyIsImhlYXJ0YmVhdF9kZWxheSIsImRpc2Nvbm5lY3RfZGVsYXkiLCJqc2Vzc2lvbmlkIiwiVVNFX0pTRVNTSU9OSUQiLCJESVNBQkxFX1dFQlNPQ0tFVFMiLCJ3ZWJzb2NrZXQiLCJmYXllX3NlcnZlcl9vcHRpb25zIiwic2VydmVyIiwiY3JlYXRlU2VydmVyIiwiV2ViQXBwIiwiaHR0cFNlcnZlciIsInJlbW92ZUxpc3RlbmVyIiwiX3RpbWVvdXRBZGp1c3RtZW50UmVxdWVzdENhbGxiYWNrIiwiaW5zdGFsbEhhbmRsZXJzIiwiYWRkTGlzdGVuZXIiLCJfcmVkaXJlY3RXZWJzb2NrZXRFbmRwb2ludCIsIm9uIiwic29ja2V0Iiwic2V0V2Vic29ja2V0VGltZW91dCIsInRpbWVvdXQiLCJwcm90b2NvbCIsIl9zZXNzaW9uIiwicmVjdiIsImNvbm5lY3Rpb24iLCJzZXRUaW1lb3V0Iiwic2VuZCIsImRhdGEiLCJ3cml0ZSIsIndpdGhvdXQiLCJURVNUX01FVEFEQVRBIiwic3RyaW5naWZ5IiwidGVzdE1lc3NhZ2VPbkNvbm5lY3QiLCJlYWNoIiwiY2FsbGJhY2siLCJPYmplY3QiLCJhc3NpZ24iLCJwcm90b3R5cGUiLCJyZWdpc3RlciIsImFsbF9zb2NrZXRzIiwidmFsdWVzIiwiZm9yRWFjaCIsImV2ZW50Iiwib2xkSHR0cFNlcnZlckxpc3RlbmVycyIsImxpc3RlbmVycyIsInNsaWNlIiwicmVtb3ZlQWxsTGlzdGVuZXJzIiwibmV3TGlzdGVuZXIiLCJyZXF1ZXN0IiwiYXJncyIsImFyZ3VtZW50cyIsInVybCIsInBhcnNlZFVybCIsInBhdGhuYW1lIiwiZm9ybWF0Iiwib2xkTGlzdGVuZXIiLCJhcHBseSIsIl9vYmplY3RTcHJlYWQiLCJtb2R1bGUiLCJsaW5rIiwiZGVmYXVsdCIsInYiLCJERFBTZXJ2ZXIiLCJGaWJlciIsInB1YmxpY2F0aW9uU3RyYXRlZ2llcyIsIlNFUlZFUl9NRVJHRSIsInVzZUNvbGxlY3Rpb25WaWV3IiwiZG9BY2NvdW50aW5nRm9yQ29sbGVjdGlvbiIsIk5PX01FUkdFX05PX0hJU1RPUlkiLCJOT19NRVJHRSIsIlNlc3Npb25Eb2N1bWVudFZpZXciLCJleGlzdHNJbiIsIlNldCIsImRhdGFCeUtleSIsIk1hcCIsIl9TZXNzaW9uRG9jdW1lbnRWaWV3IiwiZXh0ZW5kIiwiZ2V0RmllbGRzIiwicmV0IiwicHJlY2VkZW5jZUxpc3QiLCJrZXkiLCJ2YWx1ZSIsImNsZWFyRmllbGQiLCJzdWJzY3JpcHRpb25IYW5kbGUiLCJjaGFuZ2VDb2xsZWN0b3IiLCJnZXQiLCJyZW1vdmVkVmFsdWUiLCJ1bmRlZmluZWQiLCJpIiwibGVuZ3RoIiwicHJlY2VkZW5jZSIsInNwbGljZSIsImRlbGV0ZSIsIkVKU09OIiwiZXF1YWxzIiwiY2hhbmdlRmllbGQiLCJpc0FkZCIsImNsb25lIiwiaGFzIiwic2V0IiwiZWx0IiwiZmluZCIsIlNlc3Npb25Db2xsZWN0aW9uVmlldyIsImNvbGxlY3Rpb25OYW1lIiwic2Vzc2lvbkNhbGxiYWNrcyIsImRvY3VtZW50cyIsImNhbGxiYWNrcyIsIl9TZXNzaW9uQ29sbGVjdGlvblZpZXciLCJpc0VtcHR5Iiwic2l6ZSIsImRpZmYiLCJwcmV2aW91cyIsIkRpZmZTZXF1ZW5jZSIsImRpZmZNYXBzIiwiYm90aCIsImJpbmQiLCJkaWZmRG9jdW1lbnQiLCJyaWdodE9ubHkiLCJpZCIsIm5vd0RWIiwiYWRkZWQiLCJsZWZ0T25seSIsInByZXZEViIsInJlbW92ZWQiLCJmaWVsZHMiLCJkaWZmT2JqZWN0cyIsInByZXYiLCJub3ciLCJjaGFuZ2VkIiwiZG9jVmlldyIsImFkZCIsImNoYW5nZWRSZXN1bHQiLCJFcnJvciIsImVyciIsIlNlc3Npb24iLCJ2ZXJzaW9uIiwib3B0aW9ucyIsIlJhbmRvbSIsImluaXRpYWxpemVkIiwiaW5RdWV1ZSIsIk1ldGVvciIsIl9Eb3VibGVFbmRlZFF1ZXVlIiwiYmxvY2tlZCIsIndvcmtlclJ1bm5pbmciLCJjYWNoZWRVbmJsb2NrIiwiX25hbWVkU3VicyIsIl91bml2ZXJzYWxTdWJzIiwidXNlcklkIiwiY29sbGVjdGlvblZpZXdzIiwiX2lzU2VuZGluZyIsIl9kb250U3RhcnROZXdVbml2ZXJzYWxTdWJzIiwiX3BlbmRpbmdSZWFkeSIsIl9jbG9zZUNhbGxiYWNrcyIsIl9zb2NrZXRVcmwiLCJfcmVzcG9uZFRvUGluZ3MiLCJyZXNwb25kVG9QaW5ncyIsImNvbm5lY3Rpb25IYW5kbGUiLCJjbG9zZSIsIm9uQ2xvc2UiLCJmbiIsImNiIiwiYmluZEVudmlyb25tZW50IiwiZGVmZXIiLCJjbGllbnRBZGRyZXNzIiwiX2NsaWVudEFkZHJlc3MiLCJodHRwSGVhZGVycyIsImhlYWRlcnMiLCJtc2ciLCJzZXNzaW9uIiwic3RhcnRVbml2ZXJzYWxTdWJzIiwicnVuIiwiaGVhcnRiZWF0SW50ZXJ2YWwiLCJoZWFydGJlYXQiLCJERFBDb21tb24iLCJIZWFydGJlYXQiLCJoZWFydGJlYXRUaW1lb3V0Iiwib25UaW1lb3V0Iiwic2VuZFBpbmciLCJzdGFydCIsIlBhY2thZ2UiLCJGYWN0cyIsImluY3JlbWVudFNlcnZlckZhY3QiLCJzZW5kUmVhZHkiLCJzdWJzY3JpcHRpb25JZHMiLCJzdWJzIiwic3Vic2NyaXB0aW9uSWQiLCJfY2FuU2VuZCIsImdldFB1YmxpY2F0aW9uU3RyYXRlZ3kiLCJzZW5kQWRkZWQiLCJjb2xsZWN0aW9uIiwic2VuZENoYW5nZWQiLCJzZW5kUmVtb3ZlZCIsImdldFNlbmRDYWxsYmFja3MiLCJnZXRDb2xsZWN0aW9uVmlldyIsInZpZXciLCJoYW5kbGVycyIsInVuaXZlcnNhbF9wdWJsaXNoX2hhbmRsZXJzIiwiaGFuZGxlciIsIl9zdGFydFN1YnNjcmlwdGlvbiIsInN0b3AiLCJfbWV0ZW9yU2Vzc2lvbiIsIl9kZWFjdGl2YXRlQWxsU3Vic2NyaXB0aW9ucyIsIl9yZW1vdmVTZXNzaW9uIiwiX3ByaW50U2VudEREUCIsIl9kZWJ1ZyIsInN0cmluZ2lmeUREUCIsInNlbmRFcnJvciIsInJlYXNvbiIsIm9mZmVuZGluZ01lc3NhZ2UiLCJwcm9jZXNzTWVzc2FnZSIsIm1zZ19pbiIsIm1lc3NhZ2VSZWNlaXZlZCIsInByb2Nlc3NOZXh0Iiwic2hpZnQiLCJ1bmJsb2NrIiwib25NZXNzYWdlSG9vayIsInByb3RvY29sX2hhbmRsZXJzIiwiY2FsbCIsInN1YiIsIm5hbWUiLCJwYXJhbXMiLCJBcnJheSIsInB1Ymxpc2hfaGFuZGxlcnMiLCJlcnJvciIsIkREUFJhdGVMaW1pdGVyIiwicmF0ZUxpbWl0ZXJJbnB1dCIsInR5cGUiLCJjb25uZWN0aW9uSWQiLCJfaW5jcmVtZW50IiwicmF0ZUxpbWl0UmVzdWx0IiwiX2NoZWNrIiwiYWxsb3dlZCIsImdldEVycm9yTWVzc2FnZSIsInRpbWVUb1Jlc2V0IiwidW5zdWIiLCJfc3RvcFN1YnNjcmlwdGlvbiIsIm1ldGhvZCIsInJhbmRvbVNlZWQiLCJmZW5jZSIsIl9Xcml0ZUZlbmNlIiwib25BbGxDb21taXR0ZWQiLCJyZXRpcmUiLCJtZXRob2RzIiwibWV0aG9kX2hhbmRsZXJzIiwiYXJtIiwic2V0VXNlcklkIiwiX3NldFVzZXJJZCIsImludm9jYXRpb24iLCJNZXRob2RJbnZvY2F0aW9uIiwiaXNTaW11bGF0aW9uIiwicHJvbWlzZSIsIlByb21pc2UiLCJyZXNvbHZlIiwicmVqZWN0IiwiZ2V0Q3VycmVudE1ldGhvZEludm9jYXRpb25SZXN1bHQiLCJjdXJyZW50Q29udGV4dCIsIkREUCIsIl9DdXJyZW50TWV0aG9kSW52b2NhdGlvbiIsIl9zZXROZXdDb250ZXh0QW5kR2V0Q3VycmVudCIsInJlc3VsdCIsInJlc3VsdE9yVGhlbmFibGUiLCJtYXliZUF1ZGl0QXJndW1lbnRDaGVja3MiLCJpc1RoZW5hYmxlIiwidGhlbiIsImF3YWl0IiwiX3NldCIsIl9DdXJyZW50V3JpdGVGZW5jZSIsIndpdGhWYWx1ZSIsImZpbmlzaCIsInBheWxvYWQiLCJleGNlcHRpb24iLCJ3cmFwSW50ZXJuYWxFeGNlcHRpb24iLCJfZWFjaFN1YiIsImYiLCJfZGlmZkNvbGxlY3Rpb25WaWV3cyIsImJlZm9yZUNWcyIsImxlZnRWYWx1ZSIsInJpZ2h0VmFsdWUiLCJkb2MiLCJfZGVhY3RpdmF0ZSIsIm9sZE5hbWVkU3VicyIsIm5ld1N1YiIsIl9yZWNyZWF0ZSIsIl9ydW5IYW5kbGVyIiwiX25vWWllbGRzQWxsb3dlZCIsInN1YklkIiwiU3Vic2NyaXB0aW9uIiwidW5ibG9ja0hhbmRlciIsInN1Yk5hbWUiLCJtYXliZVN1YiIsIl9uYW1lIiwiX3JlbW92ZUFsbERvY3VtZW50cyIsInJlc3BvbnNlIiwiaHR0cEZvcndhcmRlZENvdW50IiwicGFyc2VJbnQiLCJyZW1vdGVBZGRyZXNzIiwiZm9yd2FyZGVkRm9yIiwiaXNTdHJpbmciLCJ0cmltIiwic3BsaXQiLCJfaGFuZGxlciIsIl9zdWJzY3JpcHRpb25JZCIsIl9wYXJhbXMiLCJfc3Vic2NyaXB0aW9uSGFuZGxlIiwiX2RlYWN0aXZhdGVkIiwiX3N0b3BDYWxsYmFja3MiLCJfZG9jdW1lbnRzIiwiX3JlYWR5IiwiX2lkRmlsdGVyIiwiaWRTdHJpbmdpZnkiLCJNb25nb0lEIiwiaWRQYXJzZSIsIl9DdXJyZW50UHVibGljYXRpb25JbnZvY2F0aW9uIiwiZSIsIl9pc0RlYWN0aXZhdGVkIiwiX3B1Ymxpc2hIYW5kbGVyUmVzdWx0IiwicmVzIiwiaXNDdXJzb3IiLCJjIiwiX3B1Ymxpc2hDdXJzb3IiLCJyZWFkeSIsImlzQXJyYXkiLCJhbGwiLCJjb2xsZWN0aW9uTmFtZXMiLCJfZ2V0Q29sbGVjdGlvbk5hbWUiLCJjdXIiLCJfY2FsbFN0b3BDYWxsYmFja3MiLCJjb2xsZWN0aW9uRG9jcyIsInN0cklkIiwib25TdG9wIiwiaWRzIiwiU2VydmVyIiwiZGVmYXVsdFB1YmxpY2F0aW9uU3RyYXRlZ3kiLCJvbkNvbm5lY3Rpb25Ib29rIiwiSG9vayIsImRlYnVnUHJpbnRFeGNlcHRpb25zIiwiX3B1YmxpY2F0aW9uU3RyYXRlZ2llcyIsInNlc3Npb25zIiwic3RyZWFtX3NlcnZlciIsInJhd19tc2ciLCJfcHJpbnRSZWNlaXZlZEREUCIsInBhcnNlRERQIiwiX2hhbmRsZUNvbm5lY3QiLCJvbkNvbm5lY3Rpb24iLCJzZXRQdWJsaWNhdGlvblN0cmF0ZWd5Iiwic3RyYXRlZ3kiLCJpbmNsdWRlcyIsIm9uTWVzc2FnZSIsInN1cHBvcnQiLCJjb250YWlucyIsIlNVUFBPUlRFRF9ERFBfVkVSU0lPTlMiLCJjYWxjdWxhdGVWZXJzaW9uIiwicHVibGlzaCIsImlzT2JqZWN0IiwiYXV0b3B1Ymxpc2giLCJpc19hdXRvIiwid2FybmVkX2Fib3V0X2F1dG9wdWJsaXNoIiwiZnVuYyIsInBvcCIsImNhbGxBc3luYyIsImFwcGx5QXN5bmMiLCJjdXJyZW50TWV0aG9kSW52b2NhdGlvbiIsImN1cnJlbnRQdWJsaWNhdGlvbkludm9jYXRpb24iLCJtYWtlUnBjU2VlZCIsIl91cmxGb3JTZXNzaW9uIiwic2Vzc2lvbklkIiwiY2xpZW50U3VwcG9ydGVkVmVyc2lvbnMiLCJzZXJ2ZXJTdXBwb3J0ZWRWZXJzaW9ucyIsImNvcnJlY3RWZXJzaW9uIiwiX2NhbGN1bGF0ZVZlcnNpb24iLCJjb250ZXh0IiwiaXNDbGllbnRTYWZlIiwib3JpZ2luYWxNZXNzYWdlIiwibWVzc2FnZSIsImRldGFpbHMiLCJfZXhwZWN0ZWRCeVRlc3QiLCJzdGFjayIsInNhbml0aXplZEVycm9yIiwiZGVzY3JpcHRpb24iLCJNYXRjaCIsIl9mYWlsSWZBcmd1bWVudHNBcmVOb3RBbGxDaGVja2VkIiwiRnV0dXJlIiwiYXJtZWQiLCJmaXJlZCIsInJldGlyZWQiLCJvdXRzdGFuZGluZ193cml0ZXMiLCJiZWZvcmVfZmlyZV9jYWxsYmFja3MiLCJjb21wbGV0aW9uX2NhbGxiYWNrcyIsIkVudmlyb25tZW50VmFyaWFibGUiLCJiZWdpbldyaXRlIiwiY29tbWl0dGVkIiwiX21heWJlRmlyZSIsIm9uQmVmb3JlRmlyZSIsImFybUFuZFdhaXQiLCJmdXR1cmUiLCJ3YWl0IiwiaW52b2tlQ2FsbGJhY2siLCJfQ3Jvc3NiYXIiLCJuZXh0SWQiLCJsaXN0ZW5lcnNCeUNvbGxlY3Rpb24iLCJsaXN0ZW5lcnNCeUNvbGxlY3Rpb25Db3VudCIsImZhY3RQYWNrYWdlIiwiZmFjdE5hbWUiLCJfY29sbGVjdGlvbkZvck1lc3NhZ2UiLCJsaXN0ZW4iLCJ0cmlnZ2VyIiwicmVjb3JkIiwiZmlyZSIsIm5vdGlmaWNhdGlvbiIsImxpc3RlbmVyc0ZvckNvbGxlY3Rpb24iLCJjYWxsYmFja0lkcyIsImwiLCJfbWF0Y2hlcyIsIk9iamVjdElEIiwidHJpZ2dlclZhbHVlIiwiX0ludmFsaWRhdGlvbkNyb3NzYmFyIiwiRERQX0RFRkFVTFRfQ09OTkVDVElPTl9VUkwiLCJyZWZyZXNoIl0sIm1hcHBpbmdzIjoiOzs7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QUdFLE1BSEYsRUFJRSxXQUpGLEVBS0UsT0FMRixFQU1FLFlBTkYsRUFPRSxjQVBGLEVBUUUsV0FSRixDQURGLEVBV0UsVUFBUzBMLElBQVQsRUFBZTtBQUNiL0UsUUFBTSxDQUFDK0UsSUFBRCxDQUFOLEdBQWVwUCxDQUFDLENBQUM0SSxJQUFGLENBQU95QixNQUFNLENBQUNwSSxNQUFQLENBQWNtTixJQUFkLENBQVAsRUFBNEIvRSxNQUFNLENBQUNwSSxNQUFuQyxDQUFmO0FBQ0QsQ0FiSCxFIiwiZmlsZSI6Ii9wYWNrYWdlcy9kZHAtc2VydmVyLmpzIiwic291cmNlc0NvbnRlbnQiOlsiLy8gQnkgZGVmYXVsdCwgd2UgdXNlIHRoZSBwZXJtZXNzYWdlLWRlZmxhdGUgZXh0ZW5zaW9uIHdpdGggZGVmYXVsdFxuLy8gY29uZmlndXJhdGlvbi4gSWYgJFNFUlZFUl9XRUJTT0NLRVRfQ09NUFJFU1NJT04gaXMgc2V0LCB0aGVuIGl0IG11c3QgYmUgdmFsaWRcbi8vIEpTT04uIElmIGl0IHJlcHJlc2VudHMgYSBmYWxzZXkgdmFsdWUsIHRoZW4gd2UgZG8gbm90IHVzZSBwZXJtZXNzYWdlLWRlZmxhdGVcbi8vIGF0IGFsbDsgb3RoZXJ3aXNlLCB0aGUgSlNPTiB2YWx1ZSBpcyB1c2VkIGFzIGFuIGFyZ3VtZW50IHRvIGRlZmxhdGUnc1xuLy8gY29uZmlndXJlIG1ldGhvZDsgc2VlXG4vLyBodHRwczovL2dpdGh1Yi5jb20vZmF5ZS9wZXJtZXNzYWdlLWRlZmxhdGUtbm9kZS9ibG9iL21hc3Rlci9SRUFETUUubWRcbi8vXG4vLyAoV2UgZG8gdGhpcyBpbiBhbiBfLm9uY2UgaW5zdGVhZCBvZiBhdCBzdGFydHVwLCBiZWNhdXNlIHdlIGRvbid0IHdhbnQgdG9cbi8vIGNyYXNoIHRoZSB0b29sIGR1cmluZyBpc29wYWNrZXQgbG9hZCBpZiB5b3VyIEpTT04gZG9lc24ndCBwYXJzZS4gVGhpcyBpcyBvbmx5XG4vLyBhIHByb2JsZW0gYmVjYXVzZSB0aGUgdG9vbCBoYXMgdG8gbG9hZCB0aGUgRERQIHNlcnZlciBjb2RlIGp1c3QgaW4gb3JkZXIgdG9cbi8vIGJlIGEgRERQIGNsaWVudDsgc2VlIGh0dHBzOi8vZ2l0aHViLmNvbS9tZXRlb3IvbWV0ZW9yL2lzc3Vlcy8zNDUyIC4pXG52YXIgd2Vic29ja2V0RXh0ZW5zaW9ucyA9IF8ub25jZShmdW5jdGlvbiAoKSB7XG4gIHZhciBleHRlbnNpb25zID0gW107XG5cbiAgdmFyIHdlYnNvY2tldENvbXByZXNzaW9uQ29uZmlnID0gcHJvY2Vzcy5lbnYuU0VSVkVSX1dFQlNPQ0tFVF9DT01QUkVTU0lPTlxuICAgICAgICA/IEpTT04ucGFyc2UocHJvY2Vzcy5lbnYuU0VSVkVSX1dFQlNPQ0tFVF9DT01QUkVTU0lPTikgOiB7fTtcbiAgaWYgKHdlYnNvY2tldENvbXByZXNzaW9uQ29uZmlnKSB7XG4gICAgZXh0ZW5zaW9ucy5wdXNoKE5wbS5yZXF1aXJlKCdwZXJtZXNzYWdlLWRlZmxhdGUnKS5jb25maWd1cmUoXG4gICAgICB3ZWJzb2NrZXRDb21wcmVzc2lvbkNvbmZpZ1xuICAgICkpO1xuICB9XG5cbiAgcmV0dXJuIGV4dGVuc2lvbnM7XG59KTtcblxudmFyIHBhdGhQcmVmaXggPSBfX21ldGVvcl9ydW50aW1lX2NvbmZpZ19fLlJPT1RfVVJMX1BBVEhfUFJFRklYIHx8ICBcIlwiO1xuXG5TdHJlYW1TZXJ2ZXIgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgc2VsZi5yZWdpc3RyYXRpb25fY2FsbGJhY2tzID0gW107XG4gIHNlbGYub3Blbl9zb2NrZXRzID0gW107XG5cbiAgLy8gQmVjYXVzZSB3ZSBhcmUgaW5zdGFsbGluZyBkaXJlY3RseSBvbnRvIFdlYkFwcC5odHRwU2VydmVyIGluc3RlYWQgb2YgdXNpbmdcbiAgLy8gV2ViQXBwLmFwcCwgd2UgaGF2ZSB0byBwcm9jZXNzIHRoZSBwYXRoIHByZWZpeCBvdXJzZWx2ZXMuXG4gIHNlbGYucHJlZml4ID0gcGF0aFByZWZpeCArICcvc29ja2pzJztcbiAgUm91dGVQb2xpY3kuZGVjbGFyZShzZWxmLnByZWZpeCArICcvJywgJ25ldHdvcmsnKTtcblxuICAvLyBzZXQgdXAgc29ja2pzXG4gIHZhciBzb2NranMgPSBOcG0ucmVxdWlyZSgnc29ja2pzJyk7XG4gIHZhciBzZXJ2ZXJPcHRpb25zID0ge1xuICAgIHByZWZpeDogc2VsZi5wcmVmaXgsXG4gICAgbG9nOiBmdW5jdGlvbigpIHt9LFxuICAgIC8vIHRoaXMgaXMgdGhlIGRlZmF1bHQsIGJ1dCB3ZSBjb2RlIGl0IGV4cGxpY2l0bHkgYmVjYXVzZSB3ZSBkZXBlbmRcbiAgICAvLyBvbiBpdCBpbiBzdHJlYW1fY2xpZW50OkhFQVJUQkVBVF9USU1FT1VUXG4gICAgaGVhcnRiZWF0X2RlbGF5OiA0NTAwMCxcbiAgICAvLyBUaGUgZGVmYXVsdCBkaXNjb25uZWN0X2RlbGF5IGlzIDUgc2Vjb25kcywgYnV0IGlmIHRoZSBzZXJ2ZXIgZW5kcyB1cCBDUFVcbiAgICAvLyBib3VuZCBmb3IgdGhhdCBtdWNoIHRpbWUsIFNvY2tKUyBtaWdodCBub3Qgbm90aWNlIHRoYXQgdGhlIHVzZXIgaGFzXG4gICAgLy8gcmVjb25uZWN0ZWQgYmVjYXVzZSB0aGUgdGltZXIgKG9mIGRpc2Nvbm5lY3RfZGVsYXkgbXMpIGNhbiBmaXJlIGJlZm9yZVxuICAgIC8vIFNvY2tKUyBwcm9jZXNzZXMgdGhlIG5ldyBjb25uZWN0aW9uLiBFdmVudHVhbGx5IHdlJ2xsIGZpeCB0aGlzIGJ5IG5vdFxuICAgIC8vIGNvbWJpbmluZyBDUFUtaGVhdnkgcHJvY2Vzc2luZyB3aXRoIFNvY2tKUyB0ZXJtaW5hdGlvbiAoZWcgYSBwcm94eSB3aGljaFxuICAgIC8vIGNvbnZlcnRzIHRvIFVuaXggc29ja2V0cykgYnV0IGZvciBub3csIHJhaXNlIHRoZSBkZWxheS5cbiAgICBkaXNjb25uZWN0X2RlbGF5OiA2MCAqIDEwMDAsXG4gICAgLy8gU2V0IHRoZSBVU0VfSlNFU1NJT05JRCBlbnZpcm9ubWVudCB2YXJpYWJsZSB0byBlbmFibGUgc2V0dGluZyB0aGVcbiAgICAvLyBKU0VTU0lPTklEIGNvb2tpZS4gVGhpcyBpcyB1c2VmdWwgZm9yIHNldHRpbmcgdXAgcHJveGllcyB3aXRoXG4gICAgLy8gc2Vzc2lvbiBhZmZpbml0eS5cbiAgICBqc2Vzc2lvbmlkOiAhIXByb2Nlc3MuZW52LlVTRV9KU0VTU0lPTklEXG4gIH07XG5cbiAgLy8gSWYgeW91IGtub3cgeW91ciBzZXJ2ZXIgZW52aXJvbm1lbnQgKGVnLCBwcm94aWVzKSB3aWxsIHByZXZlbnQgd2Vic29ja2V0c1xuICAvLyBmcm9tIGV2ZXIgd29ya2luZywgc2V0ICRESVNBQkxFX1dFQlNPQ0tFVFMgYW5kIFNvY2tKUyBjbGllbnRzIChpZSxcbiAgLy8gYnJvd3NlcnMpIHdpbGwgbm90IHdhc3RlIHRpbWUgYXR0ZW1wdGluZyB0byB1c2UgdGhlbS5cbiAgLy8gKFlvdXIgc2VydmVyIHdpbGwgc3RpbGwgaGF2ZSBhIC93ZWJzb2NrZXQgZW5kcG9pbnQuKVxuICBpZiAocHJvY2Vzcy5lbnYuRElTQUJMRV9XRUJTT0NLRVRTKSB7XG4gICAgc2VydmVyT3B0aW9ucy53ZWJzb2NrZXQgPSBmYWxzZTtcbiAgfSBlbHNlIHtcbiAgICBzZXJ2ZXJPcHRpb25zLmZheWVfc2VydmVyX29wdGlvbnMgPSB7XG4gICAgICBleHRlbnNpb25zOiB3ZWJzb2NrZXRFeHRlbnNpb25zKClcbiAgICB9O1xuICB9XG5cbiAgc2VsZi5zZXJ2ZXIgPSBzb2NranMuY3JlYXRlU2VydmVyKHNlcnZlck9wdGlvbnMpO1xuXG4gIC8vIEluc3RhbGwgdGhlIHNvY2tqcyBoYW5kbGVycywgYnV0IHdlIHdhbnQgdG8ga2VlcCBhcm91bmQgb3VyIG93biBwYXJ0aWN1bGFyXG4gIC8vIHJlcXVlc3QgaGFuZGxlciB0aGF0IGFkanVzdHMgaWRsZSB0aW1lb3V0cyB3aGlsZSB3ZSBoYXZlIGFuIG91dHN0YW5kaW5nXG4gIC8vIHJlcXVlc3QuICBUaGlzIGNvbXBlbnNhdGVzIGZvciB0aGUgZmFjdCB0aGF0IHNvY2tqcyByZW1vdmVzIGFsbCBsaXN0ZW5lcnNcbiAgLy8gZm9yIFwicmVxdWVzdFwiIHRvIGFkZCBpdHMgb3duLlxuICBXZWJBcHAuaHR0cFNlcnZlci5yZW1vdmVMaXN0ZW5lcihcbiAgICAncmVxdWVzdCcsIFdlYkFwcC5fdGltZW91dEFkanVzdG1lbnRSZXF1ZXN0Q2FsbGJhY2spO1xuICBzZWxmLnNlcnZlci5pbnN0YWxsSGFuZGxlcnMoV2ViQXBwLmh0dHBTZXJ2ZXIpO1xuICBXZWJBcHAuaHR0cFNlcnZlci5hZGRMaXN0ZW5lcihcbiAgICAncmVxdWVzdCcsIFdlYkFwcC5fdGltZW91dEFkanVzdG1lbnRSZXF1ZXN0Q2FsbGJhY2spO1xuXG4gIC8vIFN1cHBvcnQgdGhlIC93ZWJzb2NrZXQgZW5kcG9pbnRcbiAgc2VsZi5fcmVkaXJlY3RXZWJzb2NrZXRFbmRwb2ludCgpO1xuXG4gIHNlbGYuc2VydmVyLm9uKCdjb25uZWN0aW9uJywgZnVuY3Rpb24gKHNvY2tldCkge1xuICAgIC8vIHNvY2tqcyBzb21ldGltZXMgcGFzc2VzIHVzIG51bGwgaW5zdGVhZCBvZiBhIHNvY2tldCBvYmplY3RcbiAgICAvLyBzbyB3ZSBuZWVkIHRvIGd1YXJkIGFnYWluc3QgdGhhdC4gc2VlOlxuICAgIC8vIGh0dHBzOi8vZ2l0aHViLmNvbS9zb2NranMvc29ja2pzLW5vZGUvaXNzdWVzLzEyMVxuICAgIC8vIGh0dHBzOi8vZ2l0aHViLmNvbS9tZXRlb3IvbWV0ZW9yL2lzc3Vlcy8xMDQ2OFxuICAgIGlmICghc29ja2V0KSByZXR1cm47XG5cbiAgICAvLyBXZSB3YW50IHRvIG1ha2Ugc3VyZSB0aGF0IGlmIGEgY2xpZW50IGNvbm5lY3RzIHRvIHVzIGFuZCBkb2VzIHRoZSBpbml0aWFsXG4gICAgLy8gV2Vic29ja2V0IGhhbmRzaGFrZSBidXQgbmV2ZXIgZ2V0cyB0byB0aGUgRERQIGhhbmRzaGFrZSwgdGhhdCB3ZVxuICAgIC8vIGV2ZW50dWFsbHkga2lsbCB0aGUgc29ja2V0LiAgT25jZSB0aGUgRERQIGhhbmRzaGFrZSBoYXBwZW5zLCBERFBcbiAgICAvLyBoZWFydGJlYXRpbmcgd2lsbCB3b3JrLiBBbmQgYmVmb3JlIHRoZSBXZWJzb2NrZXQgaGFuZHNoYWtlLCB0aGUgdGltZW91dHNcbiAgICAvLyB3ZSBzZXQgYXQgdGhlIHNlcnZlciBsZXZlbCBpbiB3ZWJhcHBfc2VydmVyLmpzIHdpbGwgd29yay4gQnV0XG4gICAgLy8gZmF5ZS13ZWJzb2NrZXQgY2FsbHMgc2V0VGltZW91dCgwKSBvbiBhbnkgc29ja2V0IGl0IHRha2VzIG92ZXIsIHNvIHRoZXJlXG4gICAgLy8gaXMgYW4gXCJpbiBiZXR3ZWVuXCIgc3RhdGUgd2hlcmUgdGhpcyBkb2Vzbid0IGhhcHBlbi4gIFdlIHdvcmsgYXJvdW5kIHRoaXNcbiAgICAvLyBieSBleHBsaWNpdGx5IHNldHRpbmcgdGhlIHNvY2tldCB0aW1lb3V0IHRvIGEgcmVsYXRpdmVseSBsYXJnZSB0aW1lIGhlcmUsXG4gICAgLy8gYW5kIHNldHRpbmcgaXQgYmFjayB0byB6ZXJvIHdoZW4gd2Ugc2V0IHVwIHRoZSBoZWFydGJlYXQgaW5cbiAgICAvLyBsaXZlZGF0YV9zZXJ2ZXIuanMuXG4gICAgc29ja2V0LnNldFdlYnNvY2tldFRpbWVvdXQgPSBmdW5jdGlvbiAodGltZW91dCkge1xuICAgICAgaWYgKChzb2NrZXQucHJvdG9jb2wgPT09ICd3ZWJzb2NrZXQnIHx8XG4gICAgICAgICAgIHNvY2tldC5wcm90b2NvbCA9PT0gJ3dlYnNvY2tldC1yYXcnKVxuICAgICAgICAgICYmIHNvY2tldC5fc2Vzc2lvbi5yZWN2KSB7XG4gICAgICAgIHNvY2tldC5fc2Vzc2lvbi5yZWN2LmNvbm5lY3Rpb24uc2V0VGltZW91dCh0aW1lb3V0KTtcbiAgICAgIH1cbiAgICB9O1xuICAgIHNvY2tldC5zZXRXZWJzb2NrZXRUaW1lb3V0KDQ1ICogMTAwMCk7XG5cbiAgICBzb2NrZXQuc2VuZCA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gICAgICBzb2NrZXQud3JpdGUoZGF0YSk7XG4gICAgfTtcbiAgICBzb2NrZXQub24oJ2Nsb3NlJywgZnVuY3Rpb24gKCkge1xuICAgICAgc2VsZi5vcGVuX3NvY2tldHMgPSBfLndpdGhvdXQoc2VsZi5vcGVuX3NvY2tldHMsIHNvY2tldCk7XG4gICAgfSk7XG4gICAgc2VsZi5vcGVuX3NvY2tldHMucHVzaChzb2NrZXQpO1xuXG4gICAgLy8gb25seSB0byBzZW5kIGEgbWVzc2FnZSBhZnRlciBjb25uZWN0aW9uIG9uIHRlc3RzLCB1c2VmdWwgZm9yXG4gICAgLy8gc29ja2V0LXN0cmVhbS1jbGllbnQvc2VydmVyLXRlc3RzLmpzXG4gICAgaWYgKHByb2Nlc3MuZW52LlRFU1RfTUVUQURBVEEgJiYgcHJvY2Vzcy5lbnYuVEVTVF9NRVRBREFUQSAhPT0gXCJ7fVwiKSB7XG4gICAgICBzb2NrZXQuc2VuZChKU09OLnN0cmluZ2lmeSh7IHRlc3RNZXNzYWdlT25Db25uZWN0OiB0cnVlIH0pKTtcbiAgICB9XG5cbiAgICAvLyBjYWxsIGFsbCBvdXIgY2FsbGJhY2tzIHdoZW4gd2UgZ2V0IGEgbmV3IHNvY2tldC4gdGhleSB3aWxsIGRvIHRoZVxuICAgIC8vIHdvcmsgb2Ygc2V0dGluZyB1cCBoYW5kbGVycyBhbmQgc3VjaCBmb3Igc3BlY2lmaWMgbWVzc2FnZXMuXG4gICAgXy5lYWNoKHNlbGYucmVnaXN0cmF0aW9uX2NhbGxiYWNrcywgZnVuY3Rpb24gKGNhbGxiYWNrKSB7XG4gICAgICBjYWxsYmFjayhzb2NrZXQpO1xuICAgIH0pO1xuICB9KTtcblxufTtcblxuT2JqZWN0LmFzc2lnbihTdHJlYW1TZXJ2ZXIucHJvdG90eXBlLCB7XG4gIC8vIGNhbGwgbXkgY2FsbGJhY2sgd2hlbiBhIG5ldyBzb2NrZXQgY29ubmVjdHMuXG4gIC8vIGFsc28gY2FsbCBpdCBmb3IgYWxsIGN1cnJlbnQgY29ubmVjdGlvbnMuXG4gIHJlZ2lzdGVyOiBmdW5jdGlvbiAoY2FsbGJhY2spIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgc2VsZi5yZWdpc3RyYXRpb25fY2FsbGJhY2tzLnB1c2goY2FsbGJhY2spO1xuICAgIF8uZWFjaChzZWxmLmFsbF9zb2NrZXRzKCksIGZ1bmN0aW9uIChzb2NrZXQpIHtcbiAgICAgIGNhbGxiYWNrKHNvY2tldCk7XG4gICAgfSk7XG4gIH0sXG5cbiAgLy8gZ2V0IGEgbGlzdCBvZiBhbGwgc29ja2V0c1xuICBhbGxfc29ja2V0czogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICByZXR1cm4gXy52YWx1ZXMoc2VsZi5vcGVuX3NvY2tldHMpO1xuICB9LFxuXG4gIC8vIFJlZGlyZWN0IC93ZWJzb2NrZXQgdG8gL3NvY2tqcy93ZWJzb2NrZXQgaW4gb3JkZXIgdG8gbm90IGV4cG9zZVxuICAvLyBzb2NranMgdG8gY2xpZW50cyB0aGF0IHdhbnQgdG8gdXNlIHJhdyB3ZWJzb2NrZXRzXG4gIF9yZWRpcmVjdFdlYnNvY2tldEVuZHBvaW50OiBmdW5jdGlvbigpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgLy8gVW5mb3J0dW5hdGVseSB3ZSBjYW4ndCB1c2UgYSBjb25uZWN0IG1pZGRsZXdhcmUgaGVyZSBzaW5jZVxuICAgIC8vIHNvY2tqcyBpbnN0YWxscyBpdHNlbGYgcHJpb3IgdG8gYWxsIGV4aXN0aW5nIGxpc3RlbmVyc1xuICAgIC8vIChtZWFuaW5nIHByaW9yIHRvIGFueSBjb25uZWN0IG1pZGRsZXdhcmVzKSBzbyB3ZSBuZWVkIHRvIHRha2VcbiAgICAvLyBhbiBhcHByb2FjaCBzaW1pbGFyIHRvIG92ZXJzaGFkb3dMaXN0ZW5lcnMgaW5cbiAgICAvLyBodHRwczovL2dpdGh1Yi5jb20vc29ja2pzL3NvY2tqcy1ub2RlL2Jsb2IvY2Y4MjBjNTVhZjZhOTk1M2UxNjU1ODU1NWEzMWRlY2VhNTU0ZjcwZS9zcmMvdXRpbHMuY29mZmVlXG4gICAgWydyZXF1ZXN0JywgJ3VwZ3JhZGUnXS5mb3JFYWNoKChldmVudCkgPT4ge1xuICAgICAgdmFyIGh0dHBTZXJ2ZXIgPSBXZWJBcHAuaHR0cFNlcnZlcjtcbiAgICAgIHZhciBvbGRIdHRwU2VydmVyTGlzdGVuZXJzID0gaHR0cFNlcnZlci5saXN0ZW5lcnMoZXZlbnQpLnNsaWNlKDApO1xuICAgICAgaHR0cFNlcnZlci5yZW1vdmVBbGxMaXN0ZW5lcnMoZXZlbnQpO1xuXG4gICAgICAvLyByZXF1ZXN0IGFuZCB1cGdyYWRlIGhhdmUgZGlmZmVyZW50IGFyZ3VtZW50cyBwYXNzZWQgYnV0XG4gICAgICAvLyB3ZSBvbmx5IGNhcmUgYWJvdXQgdGhlIGZpcnN0IG9uZSB3aGljaCBpcyBhbHdheXMgcmVxdWVzdFxuICAgICAgdmFyIG5ld0xpc3RlbmVyID0gZnVuY3Rpb24ocmVxdWVzdCAvKiwgbW9yZUFyZ3VtZW50cyAqLykge1xuICAgICAgICAvLyBTdG9yZSBhcmd1bWVudHMgZm9yIHVzZSB3aXRoaW4gdGhlIGNsb3N1cmUgYmVsb3dcbiAgICAgICAgdmFyIGFyZ3MgPSBhcmd1bWVudHM7XG5cbiAgICAgICAgLy8gVE9ETyByZXBsYWNlIHdpdGggdXJsIHBhY2thZ2VcbiAgICAgICAgdmFyIHVybCA9IE5wbS5yZXF1aXJlKCd1cmwnKTtcblxuICAgICAgICAvLyBSZXdyaXRlIC93ZWJzb2NrZXQgYW5kIC93ZWJzb2NrZXQvIHVybHMgdG8gL3NvY2tqcy93ZWJzb2NrZXQgd2hpbGVcbiAgICAgICAgLy8gcHJlc2VydmluZyBxdWVyeSBzdHJpbmcuXG4gICAgICAgIHZhciBwYXJzZWRVcmwgPSB1cmwucGFyc2UocmVxdWVzdC51cmwpO1xuICAgICAgICBpZiAocGFyc2VkVXJsLnBhdGhuYW1lID09PSBwYXRoUHJlZml4ICsgJy93ZWJzb2NrZXQnIHx8XG4gICAgICAgICAgICBwYXJzZWRVcmwucGF0aG5hbWUgPT09IHBhdGhQcmVmaXggKyAnL3dlYnNvY2tldC8nKSB7XG4gICAgICAgICAgcGFyc2VkVXJsLnBhdGhuYW1lID0gc2VsZi5wcmVmaXggKyAnL3dlYnNvY2tldCc7XG4gICAgICAgICAgcmVxdWVzdC51cmwgPSB1cmwuZm9ybWF0KHBhcnNlZFVybCk7XG4gICAgICAgIH1cbiAgICAgICAgXy5lYWNoKG9sZEh0dHBTZXJ2ZXJMaXN0ZW5lcnMsIGZ1bmN0aW9uKG9sZExpc3RlbmVyKSB7XG4gICAgICAgICAgb2xkTGlzdGVuZXIuYXBwbHkoaHR0cFNlcnZlciwgYXJncyk7XG4gICAgICAgIH0pO1xuICAgICAgfTtcbiAgICAgIGh0dHBTZXJ2ZXIuYWRkTGlzdGVuZXIoZXZlbnQsIG5ld0xpc3RlbmVyKTtcbiAgICB9KTtcbiAgfVxufSk7XG4iLCJERFBTZXJ2ZXIgPSB7fTtcblxudmFyIEZpYmVyID0gTnBtLnJlcXVpcmUoJ2ZpYmVycycpO1xuXG4vLyBQdWJsaWNhdGlvbiBzdHJhdGVnaWVzIGRlZmluZSBob3cgd2UgaGFuZGxlIGRhdGEgZnJvbSBwdWJsaXNoZWQgY3Vyc29ycyBhdCB0aGUgY29sbGVjdGlvbiBsZXZlbFxuLy8gVGhpcyBhbGxvd3Mgc29tZW9uZSB0bzpcbi8vIC0gQ2hvb3NlIGEgdHJhZGUtb2ZmIGJldHdlZW4gY2xpZW50LXNlcnZlciBiYW5kd2lkdGggYW5kIHNlcnZlciBtZW1vcnkgdXNhZ2Vcbi8vIC0gSW1wbGVtZW50IHNwZWNpYWwgKG5vbi1tb25nbykgY29sbGVjdGlvbnMgbGlrZSB2b2xhdGlsZSBtZXNzYWdlIHF1ZXVlc1xuY29uc3QgcHVibGljYXRpb25TdHJhdGVnaWVzID0ge1xuICAvLyBTRVJWRVJfTUVSR0UgaXMgdGhlIGRlZmF1bHQgc3RyYXRlZ3kuXG4gIC8vIFdoZW4gdXNpbmcgdGhpcyBzdHJhdGVneSwgdGhlIHNlcnZlciBtYWludGFpbnMgYSBjb3B5IG9mIGFsbCBkYXRhIGEgY29ubmVjdGlvbiBpcyBzdWJzY3JpYmVkIHRvLlxuICAvLyBUaGlzIGFsbG93cyB1cyB0byBvbmx5IHNlbmQgZGVsdGFzIG92ZXIgbXVsdGlwbGUgcHVibGljYXRpb25zLlxuICBTRVJWRVJfTUVSR0U6IHtcbiAgICB1c2VDb2xsZWN0aW9uVmlldzogdHJ1ZSxcbiAgICBkb0FjY291bnRpbmdGb3JDb2xsZWN0aW9uOiB0cnVlLFxuICB9LFxuICAvLyBUaGUgTk9fTUVSR0VfTk9fSElTVE9SWSBzdHJhdGVneSByZXN1bHRzIGluIHRoZSBzZXJ2ZXIgc2VuZGluZyBhbGwgcHVibGljYXRpb24gZGF0YVxuICAvLyBkaXJlY3RseSB0byB0aGUgY2xpZW50LiBJdCBkb2VzIG5vdCByZW1lbWJlciB3aGF0IGl0IGhhcyBwcmV2aW91c2x5IHNlbnRcbiAgLy8gdG8gaXQgd2lsbCBub3QgdHJpZ2dlciByZW1vdmVkIG1lc3NhZ2VzIHdoZW4gYSBzdWJzY3JpcHRpb24gaXMgc3RvcHBlZC5cbiAgLy8gVGhpcyBzaG91bGQgb25seSBiZSBjaG9zZW4gZm9yIHNwZWNpYWwgdXNlIGNhc2VzIGxpa2Ugc2VuZC1hbmQtZm9yZ2V0IHF1ZXVlcy5cbiAgTk9fTUVSR0VfTk9fSElTVE9SWToge1xuICAgIHVzZUNvbGxlY3Rpb25WaWV3OiBmYWxzZSxcbiAgICBkb0FjY291bnRpbmdGb3JDb2xsZWN0aW9uOiBmYWxzZSxcbiAgfSxcbiAgLy8gTk9fTUVSR0UgaXMgc2ltaWxhciB0byBOT19NRVJHRV9OT19ISVNUT1JZIGJ1dCB0aGUgc2VydmVyIHdpbGwgcmVtZW1iZXIgdGhlIElEcyBpdCBoYXNcbiAgLy8gc2VudCB0byB0aGUgY2xpZW50IHNvIGl0IGNhbiByZW1vdmUgdGhlbSB3aGVuIGEgc3Vic2NyaXB0aW9uIGlzIHN0b3BwZWQuXG4gIC8vIFRoaXMgc3RyYXRlZ3kgY2FuIGJlIHVzZWQgd2hlbiBhIGNvbGxlY3Rpb24gaXMgb25seSB1c2VkIGluIGEgc2luZ2xlIHB1YmxpY2F0aW9uLlxuICBOT19NRVJHRToge1xuICAgIHVzZUNvbGxlY3Rpb25WaWV3OiBmYWxzZSxcbiAgICBkb0FjY291bnRpbmdGb3JDb2xsZWN0aW9uOiB0cnVlLFxuICB9XG59O1xuXG5ERFBTZXJ2ZXIucHVibGljYXRpb25TdHJhdGVnaWVzID0gcHVibGljYXRpb25TdHJhdGVnaWVzO1xuXG4vLyBUaGlzIGZpbGUgY29udGFpbnMgY2xhc3Nlczpcbi8vICogU2Vzc2lvbiAtIFRoZSBzZXJ2ZXIncyBjb25uZWN0aW9uIHRvIGEgc2luZ2xlIEREUCBjbGllbnRcbi8vICogU3Vic2NyaXB0aW9uIC0gQSBzaW5nbGUgc3Vic2NyaXB0aW9uIGZvciBhIHNpbmdsZSBjbGllbnRcbi8vICogU2VydmVyIC0gQW4gZW50aXJlIHNlcnZlciB0aGF0IG1heSB0YWxrIHRvID4gMSBjbGllbnQuIEEgRERQIGVuZHBvaW50LlxuLy9cbi8vIFNlc3Npb24gYW5kIFN1YnNjcmlwdGlvbiBhcmUgZmlsZSBzY29wZS4gRm9yIG5vdywgdW50aWwgd2UgZnJlZXplXG4vLyB0aGUgaW50ZXJmYWNlLCBTZXJ2ZXIgaXMgcGFja2FnZSBzY29wZSAoaW4gdGhlIGZ1dHVyZSBpdCBzaG91bGQgYmVcbi8vIGV4cG9ydGVkKS5cblxuLy8gUmVwcmVzZW50cyBhIHNpbmdsZSBkb2N1bWVudCBpbiBhIFNlc3Npb25Db2xsZWN0aW9uVmlld1xudmFyIFNlc3Npb25Eb2N1bWVudFZpZXcgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgc2VsZi5leGlzdHNJbiA9IG5ldyBTZXQoKTsgLy8gc2V0IG9mIHN1YnNjcmlwdGlvbkhhbmRsZVxuICBzZWxmLmRhdGFCeUtleSA9IG5ldyBNYXAoKTsgLy8ga2V5LT4gWyB7c3Vic2NyaXB0aW9uSGFuZGxlLCB2YWx1ZX0gYnkgcHJlY2VkZW5jZV1cbn07XG5cbkREUFNlcnZlci5fU2Vzc2lvbkRvY3VtZW50VmlldyA9IFNlc3Npb25Eb2N1bWVudFZpZXc7XG5cblxuXy5leHRlbmQoU2Vzc2lvbkRvY3VtZW50Vmlldy5wcm90b3R5cGUsIHtcblxuICBnZXRGaWVsZHM6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgdmFyIHJldCA9IHt9O1xuICAgIHNlbGYuZGF0YUJ5S2V5LmZvckVhY2goZnVuY3Rpb24gKHByZWNlZGVuY2VMaXN0LCBrZXkpIHtcbiAgICAgIHJldFtrZXldID0gcHJlY2VkZW5jZUxpc3RbMF0udmFsdWU7XG4gICAgfSk7XG4gICAgcmV0dXJuIHJldDtcbiAgfSxcblxuICBjbGVhckZpZWxkOiBmdW5jdGlvbiAoc3Vic2NyaXB0aW9uSGFuZGxlLCBrZXksIGNoYW5nZUNvbGxlY3Rvcikge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICAvLyBQdWJsaXNoIEFQSSBpZ25vcmVzIF9pZCBpZiBwcmVzZW50IGluIGZpZWxkc1xuICAgIGlmIChrZXkgPT09IFwiX2lkXCIpXG4gICAgICByZXR1cm47XG4gICAgdmFyIHByZWNlZGVuY2VMaXN0ID0gc2VsZi5kYXRhQnlLZXkuZ2V0KGtleSk7XG5cbiAgICAvLyBJdCdzIG9rYXkgdG8gY2xlYXIgZmllbGRzIHRoYXQgZGlkbid0IGV4aXN0LiBObyBuZWVkIHRvIHRocm93XG4gICAgLy8gYW4gZXJyb3IuXG4gICAgaWYgKCFwcmVjZWRlbmNlTGlzdClcbiAgICAgIHJldHVybjtcblxuICAgIHZhciByZW1vdmVkVmFsdWUgPSB1bmRlZmluZWQ7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBwcmVjZWRlbmNlTGlzdC5sZW5ndGg7IGkrKykge1xuICAgICAgdmFyIHByZWNlZGVuY2UgPSBwcmVjZWRlbmNlTGlzdFtpXTtcbiAgICAgIGlmIChwcmVjZWRlbmNlLnN1YnNjcmlwdGlvbkhhbmRsZSA9PT0gc3Vic2NyaXB0aW9uSGFuZGxlKSB7XG4gICAgICAgIC8vIFRoZSB2aWV3J3MgdmFsdWUgY2FuIG9ubHkgY2hhbmdlIGlmIHRoaXMgc3Vic2NyaXB0aW9uIGlzIHRoZSBvbmUgdGhhdFxuICAgICAgICAvLyB1c2VkIHRvIGhhdmUgcHJlY2VkZW5jZS5cbiAgICAgICAgaWYgKGkgPT09IDApXG4gICAgICAgICAgcmVtb3ZlZFZhbHVlID0gcHJlY2VkZW5jZS52YWx1ZTtcbiAgICAgICAgcHJlY2VkZW5jZUxpc3Quc3BsaWNlKGksIDEpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHByZWNlZGVuY2VMaXN0Lmxlbmd0aCA9PT0gMCkge1xuICAgICAgc2VsZi5kYXRhQnlLZXkuZGVsZXRlKGtleSk7XG4gICAgICBjaGFuZ2VDb2xsZWN0b3Jba2V5XSA9IHVuZGVmaW5lZDtcbiAgICB9IGVsc2UgaWYgKHJlbW92ZWRWYWx1ZSAhPT0gdW5kZWZpbmVkICYmXG4gICAgICAgICAgICAgICAhRUpTT04uZXF1YWxzKHJlbW92ZWRWYWx1ZSwgcHJlY2VkZW5jZUxpc3RbMF0udmFsdWUpKSB7XG4gICAgICBjaGFuZ2VDb2xsZWN0b3Jba2V5XSA9IHByZWNlZGVuY2VMaXN0WzBdLnZhbHVlO1xuICAgIH1cbiAgfSxcblxuICBjaGFuZ2VGaWVsZDogZnVuY3Rpb24gKHN1YnNjcmlwdGlvbkhhbmRsZSwga2V5LCB2YWx1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICBjaGFuZ2VDb2xsZWN0b3IsIGlzQWRkKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIC8vIFB1Ymxpc2ggQVBJIGlnbm9yZXMgX2lkIGlmIHByZXNlbnQgaW4gZmllbGRzXG4gICAgaWYgKGtleSA9PT0gXCJfaWRcIilcbiAgICAgIHJldHVybjtcblxuICAgIC8vIERvbid0IHNoYXJlIHN0YXRlIHdpdGggdGhlIGRhdGEgcGFzc2VkIGluIGJ5IHRoZSB1c2VyLlxuICAgIHZhbHVlID0gRUpTT04uY2xvbmUodmFsdWUpO1xuXG4gICAgaWYgKCFzZWxmLmRhdGFCeUtleS5oYXMoa2V5KSkge1xuICAgICAgc2VsZi5kYXRhQnlLZXkuc2V0KGtleSwgW3tzdWJzY3JpcHRpb25IYW5kbGU6IHN1YnNjcmlwdGlvbkhhbmRsZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWU6IHZhbHVlfV0pO1xuICAgICAgY2hhbmdlQ29sbGVjdG9yW2tleV0gPSB2YWx1ZTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdmFyIHByZWNlZGVuY2VMaXN0ID0gc2VsZi5kYXRhQnlLZXkuZ2V0KGtleSk7XG4gICAgdmFyIGVsdDtcbiAgICBpZiAoIWlzQWRkKSB7XG4gICAgICBlbHQgPSBwcmVjZWRlbmNlTGlzdC5maW5kKGZ1bmN0aW9uIChwcmVjZWRlbmNlKSB7XG4gICAgICAgICAgcmV0dXJuIHByZWNlZGVuY2Uuc3Vic2NyaXB0aW9uSGFuZGxlID09PSBzdWJzY3JpcHRpb25IYW5kbGU7XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAoZWx0KSB7XG4gICAgICBpZiAoZWx0ID09PSBwcmVjZWRlbmNlTGlzdFswXSAmJiAhRUpTT04uZXF1YWxzKHZhbHVlLCBlbHQudmFsdWUpKSB7XG4gICAgICAgIC8vIHRoaXMgc3Vic2NyaXB0aW9uIGlzIGNoYW5naW5nIHRoZSB2YWx1ZSBvZiB0aGlzIGZpZWxkLlxuICAgICAgICBjaGFuZ2VDb2xsZWN0b3Jba2V5XSA9IHZhbHVlO1xuICAgICAgfVxuICAgICAgZWx0LnZhbHVlID0gdmFsdWU7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIHRoaXMgc3Vic2NyaXB0aW9uIGlzIG5ld2x5IGNhcmluZyBhYm91dCB0aGlzIGZpZWxkXG4gICAgICBwcmVjZWRlbmNlTGlzdC5wdXNoKHtzdWJzY3JpcHRpb25IYW5kbGU6IHN1YnNjcmlwdGlvbkhhbmRsZSwgdmFsdWU6IHZhbHVlfSk7XG4gICAgfVxuXG4gIH1cbn0pO1xuXG4vKipcbiAqIFJlcHJlc2VudHMgYSBjbGllbnQncyB2aWV3IG9mIGEgc2luZ2xlIGNvbGxlY3Rpb25cbiAqIEBwYXJhbSB7U3RyaW5nfSBjb2xsZWN0aW9uTmFtZSBOYW1lIG9mIHRoZSBjb2xsZWN0aW9uIGl0IHJlcHJlc2VudHNcbiAqIEBwYXJhbSB7T2JqZWN0LjxTdHJpbmcsIEZ1bmN0aW9uPn0gc2Vzc2lvbkNhbGxiYWNrcyBUaGUgY2FsbGJhY2tzIGZvciBhZGRlZCwgY2hhbmdlZCwgcmVtb3ZlZFxuICogQGNsYXNzIFNlc3Npb25Db2xsZWN0aW9uVmlld1xuICovXG52YXIgU2Vzc2lvbkNvbGxlY3Rpb25WaWV3ID0gZnVuY3Rpb24gKGNvbGxlY3Rpb25OYW1lLCBzZXNzaW9uQ2FsbGJhY2tzKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgc2VsZi5jb2xsZWN0aW9uTmFtZSA9IGNvbGxlY3Rpb25OYW1lO1xuICBzZWxmLmRvY3VtZW50cyA9IG5ldyBNYXAoKTtcbiAgc2VsZi5jYWxsYmFja3MgPSBzZXNzaW9uQ2FsbGJhY2tzO1xufTtcblxuRERQU2VydmVyLl9TZXNzaW9uQ29sbGVjdGlvblZpZXcgPSBTZXNzaW9uQ29sbGVjdGlvblZpZXc7XG5cblxuT2JqZWN0LmFzc2lnbihTZXNzaW9uQ29sbGVjdGlvblZpZXcucHJvdG90eXBlLCB7XG5cbiAgaXNFbXB0eTogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICByZXR1cm4gc2VsZi5kb2N1bWVudHMuc2l6ZSA9PT0gMDtcbiAgfSxcblxuICBkaWZmOiBmdW5jdGlvbiAocHJldmlvdXMpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgRGlmZlNlcXVlbmNlLmRpZmZNYXBzKHByZXZpb3VzLmRvY3VtZW50cywgc2VsZi5kb2N1bWVudHMsIHtcbiAgICAgIGJvdGg6IF8uYmluZChzZWxmLmRpZmZEb2N1bWVudCwgc2VsZiksXG5cbiAgICAgIHJpZ2h0T25seTogZnVuY3Rpb24gKGlkLCBub3dEVikge1xuICAgICAgICBzZWxmLmNhbGxiYWNrcy5hZGRlZChzZWxmLmNvbGxlY3Rpb25OYW1lLCBpZCwgbm93RFYuZ2V0RmllbGRzKCkpO1xuICAgICAgfSxcblxuICAgICAgbGVmdE9ubHk6IGZ1bmN0aW9uIChpZCwgcHJldkRWKSB7XG4gICAgICAgIHNlbGYuY2FsbGJhY2tzLnJlbW92ZWQoc2VsZi5jb2xsZWN0aW9uTmFtZSwgaWQpO1xuICAgICAgfVxuICAgIH0pO1xuICB9LFxuXG4gIGRpZmZEb2N1bWVudDogZnVuY3Rpb24gKGlkLCBwcmV2RFYsIG5vd0RWKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHZhciBmaWVsZHMgPSB7fTtcbiAgICBEaWZmU2VxdWVuY2UuZGlmZk9iamVjdHMocHJldkRWLmdldEZpZWxkcygpLCBub3dEVi5nZXRGaWVsZHMoKSwge1xuICAgICAgYm90aDogZnVuY3Rpb24gKGtleSwgcHJldiwgbm93KSB7XG4gICAgICAgIGlmICghRUpTT04uZXF1YWxzKHByZXYsIG5vdykpXG4gICAgICAgICAgZmllbGRzW2tleV0gPSBub3c7XG4gICAgICB9LFxuICAgICAgcmlnaHRPbmx5OiBmdW5jdGlvbiAoa2V5LCBub3cpIHtcbiAgICAgICAgZmllbGRzW2tleV0gPSBub3c7XG4gICAgICB9LFxuICAgICAgbGVmdE9ubHk6IGZ1bmN0aW9uKGtleSwgcHJldikge1xuICAgICAgICBmaWVsZHNba2V5XSA9IHVuZGVmaW5lZDtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBzZWxmLmNhbGxiYWNrcy5jaGFuZ2VkKHNlbGYuY29sbGVjdGlvbk5hbWUsIGlkLCBmaWVsZHMpO1xuICB9LFxuXG4gIGFkZGVkOiBmdW5jdGlvbiAoc3Vic2NyaXB0aW9uSGFuZGxlLCBpZCwgZmllbGRzKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHZhciBkb2NWaWV3ID0gc2VsZi5kb2N1bWVudHMuZ2V0KGlkKTtcbiAgICB2YXIgYWRkZWQgPSBmYWxzZTtcbiAgICBpZiAoIWRvY1ZpZXcpIHtcbiAgICAgIGFkZGVkID0gdHJ1ZTtcbiAgICAgIGRvY1ZpZXcgPSBuZXcgU2Vzc2lvbkRvY3VtZW50VmlldygpO1xuICAgICAgc2VsZi5kb2N1bWVudHMuc2V0KGlkLCBkb2NWaWV3KTtcbiAgICB9XG4gICAgZG9jVmlldy5leGlzdHNJbi5hZGQoc3Vic2NyaXB0aW9uSGFuZGxlKTtcbiAgICB2YXIgY2hhbmdlQ29sbGVjdG9yID0ge307XG4gICAgXy5lYWNoKGZpZWxkcywgZnVuY3Rpb24gKHZhbHVlLCBrZXkpIHtcbiAgICAgIGRvY1ZpZXcuY2hhbmdlRmllbGQoXG4gICAgICAgIHN1YnNjcmlwdGlvbkhhbmRsZSwga2V5LCB2YWx1ZSwgY2hhbmdlQ29sbGVjdG9yLCB0cnVlKTtcbiAgICB9KTtcbiAgICBpZiAoYWRkZWQpXG4gICAgICBzZWxmLmNhbGxiYWNrcy5hZGRlZChzZWxmLmNvbGxlY3Rpb25OYW1lLCBpZCwgY2hhbmdlQ29sbGVjdG9yKTtcbiAgICBlbHNlXG4gICAgICBzZWxmLmNhbGxiYWNrcy5jaGFuZ2VkKHNlbGYuY29sbGVjdGlvbk5hbWUsIGlkLCBjaGFuZ2VDb2xsZWN0b3IpO1xuICB9LFxuXG4gIGNoYW5nZWQ6IGZ1bmN0aW9uIChzdWJzY3JpcHRpb25IYW5kbGUsIGlkLCBjaGFuZ2VkKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHZhciBjaGFuZ2VkUmVzdWx0ID0ge307XG4gICAgdmFyIGRvY1ZpZXcgPSBzZWxmLmRvY3VtZW50cy5nZXQoaWQpO1xuICAgIGlmICghZG9jVmlldylcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkNvdWxkIG5vdCBmaW5kIGVsZW1lbnQgd2l0aCBpZCBcIiArIGlkICsgXCIgdG8gY2hhbmdlXCIpO1xuICAgIF8uZWFjaChjaGFuZ2VkLCBmdW5jdGlvbiAodmFsdWUsIGtleSkge1xuICAgICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpXG4gICAgICAgIGRvY1ZpZXcuY2xlYXJGaWVsZChzdWJzY3JpcHRpb25IYW5kbGUsIGtleSwgY2hhbmdlZFJlc3VsdCk7XG4gICAgICBlbHNlXG4gICAgICAgIGRvY1ZpZXcuY2hhbmdlRmllbGQoc3Vic2NyaXB0aW9uSGFuZGxlLCBrZXksIHZhbHVlLCBjaGFuZ2VkUmVzdWx0KTtcbiAgICB9KTtcbiAgICBzZWxmLmNhbGxiYWNrcy5jaGFuZ2VkKHNlbGYuY29sbGVjdGlvbk5hbWUsIGlkLCBjaGFuZ2VkUmVzdWx0KTtcbiAgfSxcblxuICByZW1vdmVkOiBmdW5jdGlvbiAoc3Vic2NyaXB0aW9uSGFuZGxlLCBpZCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICB2YXIgZG9jVmlldyA9IHNlbGYuZG9jdW1lbnRzLmdldChpZCk7XG4gICAgaWYgKCFkb2NWaWV3KSB7XG4gICAgICB2YXIgZXJyID0gbmV3IEVycm9yKFwiUmVtb3ZlZCBub25leGlzdGVudCBkb2N1bWVudCBcIiArIGlkKTtcbiAgICAgIHRocm93IGVycjtcbiAgICB9XG4gICAgZG9jVmlldy5leGlzdHNJbi5kZWxldGUoc3Vic2NyaXB0aW9uSGFuZGxlKTtcbiAgICBpZiAoZG9jVmlldy5leGlzdHNJbi5zaXplID09PSAwKSB7XG4gICAgICAvLyBpdCBpcyBnb25lIGZyb20gZXZlcnlvbmVcbiAgICAgIHNlbGYuY2FsbGJhY2tzLnJlbW92ZWQoc2VsZi5jb2xsZWN0aW9uTmFtZSwgaWQpO1xuICAgICAgc2VsZi5kb2N1bWVudHMuZGVsZXRlKGlkKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdmFyIGNoYW5nZWQgPSB7fTtcbiAgICAgIC8vIHJlbW92ZSB0aGlzIHN1YnNjcmlwdGlvbiBmcm9tIGV2ZXJ5IHByZWNlZGVuY2UgbGlzdFxuICAgICAgLy8gYW5kIHJlY29yZCB0aGUgY2hhbmdlc1xuICAgICAgZG9jVmlldy5kYXRhQnlLZXkuZm9yRWFjaChmdW5jdGlvbiAocHJlY2VkZW5jZUxpc3QsIGtleSkge1xuICAgICAgICBkb2NWaWV3LmNsZWFyRmllbGQoc3Vic2NyaXB0aW9uSGFuZGxlLCBrZXksIGNoYW5nZWQpO1xuICAgICAgfSk7XG5cbiAgICAgIHNlbGYuY2FsbGJhY2tzLmNoYW5nZWQoc2VsZi5jb2xsZWN0aW9uTmFtZSwgaWQsIGNoYW5nZWQpO1xuICAgIH1cbiAgfVxufSk7XG5cbi8qKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiovXG4vKiBTZXNzaW9uICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqL1xuLyoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKi9cblxudmFyIFNlc3Npb24gPSBmdW5jdGlvbiAoc2VydmVyLCB2ZXJzaW9uLCBzb2NrZXQsIG9wdGlvbnMpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICBzZWxmLmlkID0gUmFuZG9tLmlkKCk7XG5cbiAgc2VsZi5zZXJ2ZXIgPSBzZXJ2ZXI7XG4gIHNlbGYudmVyc2lvbiA9IHZlcnNpb247XG5cbiAgc2VsZi5pbml0aWFsaXplZCA9IGZhbHNlO1xuICBzZWxmLnNvY2tldCA9IHNvY2tldDtcblxuICAvLyBTZXQgdG8gbnVsbCB3aGVuIHRoZSBzZXNzaW9uIGlzIGRlc3Ryb3llZC4gTXVsdGlwbGUgcGxhY2VzIGJlbG93XG4gIC8vIHVzZSB0aGlzIHRvIGRldGVybWluZSBpZiB0aGUgc2Vzc2lvbiBpcyBhbGl2ZSBvciBub3QuXG4gIHNlbGYuaW5RdWV1ZSA9IG5ldyBNZXRlb3IuX0RvdWJsZUVuZGVkUXVldWUoKTtcblxuICBzZWxmLmJsb2NrZWQgPSBmYWxzZTtcbiAgc2VsZi53b3JrZXJSdW5uaW5nID0gZmFsc2U7XG5cbiAgc2VsZi5jYWNoZWRVbmJsb2NrID0gbnVsbDtcblxuICAvLyBTdWIgb2JqZWN0cyBmb3IgYWN0aXZlIHN1YnNjcmlwdGlvbnNcbiAgc2VsZi5fbmFtZWRTdWJzID0gbmV3IE1hcCgpO1xuICBzZWxmLl91bml2ZXJzYWxTdWJzID0gW107XG5cbiAgc2VsZi51c2VySWQgPSBudWxsO1xuXG4gIHNlbGYuY29sbGVjdGlvblZpZXdzID0gbmV3IE1hcCgpO1xuXG4gIC8vIFNldCB0aGlzIHRvIGZhbHNlIHRvIG5vdCBzZW5kIG1lc3NhZ2VzIHdoZW4gY29sbGVjdGlvblZpZXdzIGFyZVxuICAvLyBtb2RpZmllZC4gVGhpcyBpcyBkb25lIHdoZW4gcmVydW5uaW5nIHN1YnMgaW4gX3NldFVzZXJJZCBhbmQgdGhvc2UgbWVzc2FnZXNcbiAgLy8gYXJlIGNhbGN1bGF0ZWQgdmlhIGEgZGlmZiBpbnN0ZWFkLlxuICBzZWxmLl9pc1NlbmRpbmcgPSB0cnVlO1xuXG4gIC8vIElmIHRoaXMgaXMgdHJ1ZSwgZG9uJ3Qgc3RhcnQgYSBuZXdseS1jcmVhdGVkIHVuaXZlcnNhbCBwdWJsaXNoZXIgb24gdGhpc1xuICAvLyBzZXNzaW9uLiBUaGUgc2Vzc2lvbiB3aWxsIHRha2UgY2FyZSBvZiBzdGFydGluZyBpdCB3aGVuIGFwcHJvcHJpYXRlLlxuICBzZWxmLl9kb250U3RhcnROZXdVbml2ZXJzYWxTdWJzID0gZmFsc2U7XG5cbiAgLy8gV2hlbiB3ZSBhcmUgcmVydW5uaW5nIHN1YnNjcmlwdGlvbnMsIGFueSByZWFkeSBtZXNzYWdlc1xuICAvLyB3ZSB3YW50IHRvIGJ1ZmZlciB1cCBmb3Igd2hlbiB3ZSBhcmUgZG9uZSByZXJ1bm5pbmcgc3Vic2NyaXB0aW9uc1xuICBzZWxmLl9wZW5kaW5nUmVhZHkgPSBbXTtcblxuICAvLyBMaXN0IG9mIGNhbGxiYWNrcyB0byBjYWxsIHdoZW4gdGhpcyBjb25uZWN0aW9uIGlzIGNsb3NlZC5cbiAgc2VsZi5fY2xvc2VDYWxsYmFja3MgPSBbXTtcblxuXG4gIC8vIFhYWCBIQUNLOiBJZiBhIHNvY2tqcyBjb25uZWN0aW9uLCBzYXZlIG9mZiB0aGUgVVJMLiBUaGlzIGlzXG4gIC8vIHRlbXBvcmFyeSBhbmQgd2lsbCBnbyBhd2F5IGluIHRoZSBuZWFyIGZ1dHVyZS5cbiAgc2VsZi5fc29ja2V0VXJsID0gc29ja2V0LnVybDtcblxuICAvLyBBbGxvdyB0ZXN0cyB0byBkaXNhYmxlIHJlc3BvbmRpbmcgdG8gcGluZ3MuXG4gIHNlbGYuX3Jlc3BvbmRUb1BpbmdzID0gb3B0aW9ucy5yZXNwb25kVG9QaW5ncztcblxuICAvLyBUaGlzIG9iamVjdCBpcyB0aGUgcHVibGljIGludGVyZmFjZSB0byB0aGUgc2Vzc2lvbi4gSW4gdGhlIHB1YmxpY1xuICAvLyBBUEksIGl0IGlzIGNhbGxlZCB0aGUgYGNvbm5lY3Rpb25gIG9iamVjdC4gIEludGVybmFsbHkgd2UgY2FsbCBpdFxuICAvLyBhIGBjb25uZWN0aW9uSGFuZGxlYCB0byBhdm9pZCBhbWJpZ3VpdHkuXG4gIHNlbGYuY29ubmVjdGlvbkhhbmRsZSA9IHtcbiAgICBpZDogc2VsZi5pZCxcbiAgICBjbG9zZTogZnVuY3Rpb24gKCkge1xuICAgICAgc2VsZi5jbG9zZSgpO1xuICAgIH0sXG4gICAgb25DbG9zZTogZnVuY3Rpb24gKGZuKSB7XG4gICAgICB2YXIgY2IgPSBNZXRlb3IuYmluZEVudmlyb25tZW50KGZuLCBcImNvbm5lY3Rpb24gb25DbG9zZSBjYWxsYmFja1wiKTtcbiAgICAgIGlmIChzZWxmLmluUXVldWUpIHtcbiAgICAgICAgc2VsZi5fY2xvc2VDYWxsYmFja3MucHVzaChjYik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBpZiB3ZSdyZSBhbHJlYWR5IGNsb3NlZCwgY2FsbCB0aGUgY2FsbGJhY2suXG4gICAgICAgIE1ldGVvci5kZWZlcihjYik7XG4gICAgICB9XG4gICAgfSxcbiAgICBjbGllbnRBZGRyZXNzOiBzZWxmLl9jbGllbnRBZGRyZXNzKCksXG4gICAgaHR0cEhlYWRlcnM6IHNlbGYuc29ja2V0LmhlYWRlcnNcbiAgfTtcblxuICBzZWxmLnNlbmQoeyBtc2c6ICdjb25uZWN0ZWQnLCBzZXNzaW9uOiBzZWxmLmlkIH0pO1xuXG4gIC8vIE9uIGluaXRpYWwgY29ubmVjdCwgc3BpbiB1cCBhbGwgdGhlIHVuaXZlcnNhbCBwdWJsaXNoZXJzLlxuICBGaWJlcihmdW5jdGlvbiAoKSB7XG4gICAgc2VsZi5zdGFydFVuaXZlcnNhbFN1YnMoKTtcbiAgfSkucnVuKCk7XG5cbiAgaWYgKHZlcnNpb24gIT09ICdwcmUxJyAmJiBvcHRpb25zLmhlYXJ0YmVhdEludGVydmFsICE9PSAwKSB7XG4gICAgLy8gV2Ugbm8gbG9uZ2VyIG5lZWQgdGhlIGxvdyBsZXZlbCB0aW1lb3V0IGJlY2F1c2Ugd2UgaGF2ZSBoZWFydGJlYXRzLlxuICAgIHNvY2tldC5zZXRXZWJzb2NrZXRUaW1lb3V0KDApO1xuXG4gICAgc2VsZi5oZWFydGJlYXQgPSBuZXcgRERQQ29tbW9uLkhlYXJ0YmVhdCh7XG4gICAgICBoZWFydGJlYXRJbnRlcnZhbDogb3B0aW9ucy5oZWFydGJlYXRJbnRlcnZhbCxcbiAgICAgIGhlYXJ0YmVhdFRpbWVvdXQ6IG9wdGlvbnMuaGVhcnRiZWF0VGltZW91dCxcbiAgICAgIG9uVGltZW91dDogZnVuY3Rpb24gKCkge1xuICAgICAgICBzZWxmLmNsb3NlKCk7XG4gICAgICB9LFxuICAgICAgc2VuZFBpbmc6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgc2VsZi5zZW5kKHttc2c6ICdwaW5nJ30pO1xuICAgICAgfVxuICAgIH0pO1xuICAgIHNlbGYuaGVhcnRiZWF0LnN0YXJ0KCk7XG4gIH1cblxuICBQYWNrYWdlWydmYWN0cy1iYXNlJ10gJiYgUGFja2FnZVsnZmFjdHMtYmFzZSddLkZhY3RzLmluY3JlbWVudFNlcnZlckZhY3QoXG4gICAgXCJsaXZlZGF0YVwiLCBcInNlc3Npb25zXCIsIDEpO1xufTtcblxuT2JqZWN0LmFzc2lnbihTZXNzaW9uLnByb3RvdHlwZSwge1xuXG4gIHNlbmRSZWFkeTogZnVuY3Rpb24gKHN1YnNjcmlwdGlvbklkcykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoc2VsZi5faXNTZW5kaW5nKVxuICAgICAgc2VsZi5zZW5kKHttc2c6IFwicmVhZHlcIiwgc3Viczogc3Vic2NyaXB0aW9uSWRzfSk7XG4gICAgZWxzZSB7XG4gICAgICBfLmVhY2goc3Vic2NyaXB0aW9uSWRzLCBmdW5jdGlvbiAoc3Vic2NyaXB0aW9uSWQpIHtcbiAgICAgICAgc2VsZi5fcGVuZGluZ1JlYWR5LnB1c2goc3Vic2NyaXB0aW9uSWQpO1xuICAgICAgfSk7XG4gICAgfVxuICB9LFxuXG4gIF9jYW5TZW5kKGNvbGxlY3Rpb25OYW1lKSB7XG4gICAgcmV0dXJuIHRoaXMuX2lzU2VuZGluZyB8fCAhdGhpcy5zZXJ2ZXIuZ2V0UHVibGljYXRpb25TdHJhdGVneShjb2xsZWN0aW9uTmFtZSkudXNlQ29sbGVjdGlvblZpZXc7XG4gIH0sXG5cblxuICBzZW5kQWRkZWQoY29sbGVjdGlvbk5hbWUsIGlkLCBmaWVsZHMpIHtcbiAgICBpZiAodGhpcy5fY2FuU2VuZChjb2xsZWN0aW9uTmFtZSkpXG4gICAgICB0aGlzLnNlbmQoe21zZzogXCJhZGRlZFwiLCBjb2xsZWN0aW9uOiBjb2xsZWN0aW9uTmFtZSwgaWQsIGZpZWxkc30pO1xuICB9LFxuXG4gIHNlbmRDaGFuZ2VkKGNvbGxlY3Rpb25OYW1lLCBpZCwgZmllbGRzKSB7XG4gICAgaWYgKF8uaXNFbXB0eShmaWVsZHMpKVxuICAgICAgcmV0dXJuO1xuXG4gICAgaWYgKHRoaXMuX2NhblNlbmQoY29sbGVjdGlvbk5hbWUpKSB7XG4gICAgICB0aGlzLnNlbmQoe1xuICAgICAgICBtc2c6IFwiY2hhbmdlZFwiLFxuICAgICAgICBjb2xsZWN0aW9uOiBjb2xsZWN0aW9uTmFtZSxcbiAgICAgICAgaWQsXG4gICAgICAgIGZpZWxkc1xuICAgICAgfSk7XG4gICAgfVxuICB9LFxuXG4gIHNlbmRSZW1vdmVkKGNvbGxlY3Rpb25OYW1lLCBpZCkge1xuICAgIGlmICh0aGlzLl9jYW5TZW5kKGNvbGxlY3Rpb25OYW1lKSlcbiAgICAgIHRoaXMuc2VuZCh7bXNnOiBcInJlbW92ZWRcIiwgY29sbGVjdGlvbjogY29sbGVjdGlvbk5hbWUsIGlkfSk7XG4gIH0sXG5cbiAgZ2V0U2VuZENhbGxiYWNrczogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICByZXR1cm4ge1xuICAgICAgYWRkZWQ6IF8uYmluZChzZWxmLnNlbmRBZGRlZCwgc2VsZiksXG4gICAgICBjaGFuZ2VkOiBfLmJpbmQoc2VsZi5zZW5kQ2hhbmdlZCwgc2VsZiksXG4gICAgICByZW1vdmVkOiBfLmJpbmQoc2VsZi5zZW5kUmVtb3ZlZCwgc2VsZilcbiAgICB9O1xuICB9LFxuXG4gIGdldENvbGxlY3Rpb25WaWV3OiBmdW5jdGlvbiAoY29sbGVjdGlvbk5hbWUpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgdmFyIHJldCA9IHNlbGYuY29sbGVjdGlvblZpZXdzLmdldChjb2xsZWN0aW9uTmFtZSk7XG4gICAgaWYgKCFyZXQpIHtcbiAgICAgIHJldCA9IG5ldyBTZXNzaW9uQ29sbGVjdGlvblZpZXcoY29sbGVjdGlvbk5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2VsZi5nZXRTZW5kQ2FsbGJhY2tzKCkpO1xuICAgICAgc2VsZi5jb2xsZWN0aW9uVmlld3Muc2V0KGNvbGxlY3Rpb25OYW1lLCByZXQpO1xuICAgIH1cbiAgICByZXR1cm4gcmV0O1xuICB9LFxuXG4gIGFkZGVkKHN1YnNjcmlwdGlvbkhhbmRsZSwgY29sbGVjdGlvbk5hbWUsIGlkLCBmaWVsZHMpIHtcbiAgICBpZiAodGhpcy5zZXJ2ZXIuZ2V0UHVibGljYXRpb25TdHJhdGVneShjb2xsZWN0aW9uTmFtZSkudXNlQ29sbGVjdGlvblZpZXcpIHtcbiAgICAgIGNvbnN0IHZpZXcgPSB0aGlzLmdldENvbGxlY3Rpb25WaWV3KGNvbGxlY3Rpb25OYW1lKTtcbiAgICAgIHZpZXcuYWRkZWQoc3Vic2NyaXB0aW9uSGFuZGxlLCBpZCwgZmllbGRzKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5zZW5kQWRkZWQoY29sbGVjdGlvbk5hbWUsIGlkLCBmaWVsZHMpO1xuICAgIH1cbiAgfSxcblxuICByZW1vdmVkKHN1YnNjcmlwdGlvbkhhbmRsZSwgY29sbGVjdGlvbk5hbWUsIGlkKSB7XG4gICAgaWYgKHRoaXMuc2VydmVyLmdldFB1YmxpY2F0aW9uU3RyYXRlZ3koY29sbGVjdGlvbk5hbWUpLnVzZUNvbGxlY3Rpb25WaWV3KSB7XG4gICAgICBjb25zdCB2aWV3ID0gdGhpcy5nZXRDb2xsZWN0aW9uVmlldyhjb2xsZWN0aW9uTmFtZSk7XG4gICAgICB2aWV3LnJlbW92ZWQoc3Vic2NyaXB0aW9uSGFuZGxlLCBpZCk7XG4gICAgICBpZiAodmlldy5pc0VtcHR5KCkpIHtcbiAgICAgICAgIHRoaXMuY29sbGVjdGlvblZpZXdzLmRlbGV0ZShjb2xsZWN0aW9uTmFtZSk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuc2VuZFJlbW92ZWQoY29sbGVjdGlvbk5hbWUsIGlkKTtcbiAgICB9XG4gIH0sXG5cbiAgY2hhbmdlZChzdWJzY3JpcHRpb25IYW5kbGUsIGNvbGxlY3Rpb25OYW1lLCBpZCwgZmllbGRzKSB7XG4gICAgaWYgKHRoaXMuc2VydmVyLmdldFB1YmxpY2F0aW9uU3RyYXRlZ3koY29sbGVjdGlvbk5hbWUpLnVzZUNvbGxlY3Rpb25WaWV3KSB7XG4gICAgICBjb25zdCB2aWV3ID0gdGhpcy5nZXRDb2xsZWN0aW9uVmlldyhjb2xsZWN0aW9uTmFtZSk7XG4gICAgICB2aWV3LmNoYW5nZWQoc3Vic2NyaXB0aW9uSGFuZGxlLCBpZCwgZmllbGRzKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5zZW5kQ2hhbmdlZChjb2xsZWN0aW9uTmFtZSwgaWQsIGZpZWxkcyk7XG4gICAgfVxuICB9LFxuXG4gIHN0YXJ0VW5pdmVyc2FsU3ViczogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICAvLyBNYWtlIGEgc2hhbGxvdyBjb3B5IG9mIHRoZSBzZXQgb2YgdW5pdmVyc2FsIGhhbmRsZXJzIGFuZCBzdGFydCB0aGVtLiBJZlxuICAgIC8vIGFkZGl0aW9uYWwgdW5pdmVyc2FsIHB1Ymxpc2hlcnMgc3RhcnQgd2hpbGUgd2UncmUgcnVubmluZyB0aGVtIChkdWUgdG9cbiAgICAvLyB5aWVsZGluZyksIHRoZXkgd2lsbCBydW4gc2VwYXJhdGVseSBhcyBwYXJ0IG9mIFNlcnZlci5wdWJsaXNoLlxuICAgIHZhciBoYW5kbGVycyA9IF8uY2xvbmUoc2VsZi5zZXJ2ZXIudW5pdmVyc2FsX3B1Ymxpc2hfaGFuZGxlcnMpO1xuICAgIF8uZWFjaChoYW5kbGVycywgZnVuY3Rpb24gKGhhbmRsZXIpIHtcbiAgICAgIHNlbGYuX3N0YXJ0U3Vic2NyaXB0aW9uKGhhbmRsZXIpO1xuICAgIH0pO1xuICB9LFxuXG4gIC8vIERlc3Ryb3kgdGhpcyBzZXNzaW9uIGFuZCB1bnJlZ2lzdGVyIGl0IGF0IHRoZSBzZXJ2ZXIuXG4gIGNsb3NlOiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gICAgLy8gRGVzdHJveSB0aGlzIHNlc3Npb24sIGV2ZW4gaWYgaXQncyBub3QgcmVnaXN0ZXJlZCBhdCB0aGVcbiAgICAvLyBzZXJ2ZXIuIFN0b3AgYWxsIHByb2Nlc3NpbmcgYW5kIHRlYXIgZXZlcnl0aGluZyBkb3duLiBJZiBhIHNvY2tldFxuICAgIC8vIHdhcyBhdHRhY2hlZCwgY2xvc2UgaXQuXG5cbiAgICAvLyBBbHJlYWR5IGRlc3Ryb3llZC5cbiAgICBpZiAoISBzZWxmLmluUXVldWUpXG4gICAgICByZXR1cm47XG5cbiAgICAvLyBEcm9wIHRoZSBtZXJnZSBib3ggZGF0YSBpbW1lZGlhdGVseS5cbiAgICBzZWxmLmluUXVldWUgPSBudWxsO1xuICAgIHNlbGYuY29sbGVjdGlvblZpZXdzID0gbmV3IE1hcCgpO1xuXG4gICAgaWYgKHNlbGYuaGVhcnRiZWF0KSB7XG4gICAgICBzZWxmLmhlYXJ0YmVhdC5zdG9wKCk7XG4gICAgICBzZWxmLmhlYXJ0YmVhdCA9IG51bGw7XG4gICAgfVxuXG4gICAgaWYgKHNlbGYuc29ja2V0KSB7XG4gICAgICBzZWxmLnNvY2tldC5jbG9zZSgpO1xuICAgICAgc2VsZi5zb2NrZXQuX21ldGVvclNlc3Npb24gPSBudWxsO1xuICAgIH1cblxuICAgIFBhY2thZ2VbJ2ZhY3RzLWJhc2UnXSAmJiBQYWNrYWdlWydmYWN0cy1iYXNlJ10uRmFjdHMuaW5jcmVtZW50U2VydmVyRmFjdChcbiAgICAgIFwibGl2ZWRhdGFcIiwgXCJzZXNzaW9uc1wiLCAtMSk7XG5cbiAgICBNZXRlb3IuZGVmZXIoZnVuY3Rpb24gKCkge1xuICAgICAgLy8gU3RvcCBjYWxsYmFja3MgY2FuIHlpZWxkLCBzbyB3ZSBkZWZlciB0aGlzIG9uIGNsb3NlLlxuICAgICAgLy8gc3ViLl9pc0RlYWN0aXZhdGVkKCkgZGV0ZWN0cyB0aGF0IHdlIHNldCBpblF1ZXVlIHRvIG51bGwgYW5kXG4gICAgICAvLyB0cmVhdHMgaXQgYXMgc2VtaS1kZWFjdGl2YXRlZCAoaXQgd2lsbCBpZ25vcmUgaW5jb21pbmcgY2FsbGJhY2tzLCBldGMpLlxuICAgICAgc2VsZi5fZGVhY3RpdmF0ZUFsbFN1YnNjcmlwdGlvbnMoKTtcblxuICAgICAgLy8gRGVmZXIgY2FsbGluZyB0aGUgY2xvc2UgY2FsbGJhY2tzLCBzbyB0aGF0IHRoZSBjYWxsZXIgY2xvc2luZ1xuICAgICAgLy8gdGhlIHNlc3Npb24gaXNuJ3Qgd2FpdGluZyBmb3IgYWxsIHRoZSBjYWxsYmFja3MgdG8gY29tcGxldGUuXG4gICAgICBfLmVhY2goc2VsZi5fY2xvc2VDYWxsYmFja3MsIGZ1bmN0aW9uIChjYWxsYmFjaykge1xuICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICAvLyBVbnJlZ2lzdGVyIHRoZSBzZXNzaW9uLlxuICAgIHNlbGYuc2VydmVyLl9yZW1vdmVTZXNzaW9uKHNlbGYpO1xuICB9LFxuXG4gIC8vIFNlbmQgYSBtZXNzYWdlIChkb2luZyBub3RoaW5nIGlmIG5vIHNvY2tldCBpcyBjb25uZWN0ZWQgcmlnaHQgbm93KS5cbiAgLy8gSXQgc2hvdWxkIGJlIGEgSlNPTiBvYmplY3QgKGl0IHdpbGwgYmUgc3RyaW5naWZpZWQpLlxuICBzZW5kOiBmdW5jdGlvbiAobXNnKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmIChzZWxmLnNvY2tldCkge1xuICAgICAgaWYgKE1ldGVvci5fcHJpbnRTZW50RERQKVxuICAgICAgICBNZXRlb3IuX2RlYnVnKFwiU2VudCBERFBcIiwgRERQQ29tbW9uLnN0cmluZ2lmeUREUChtc2cpKTtcbiAgICAgIHNlbGYuc29ja2V0LnNlbmQoRERQQ29tbW9uLnN0cmluZ2lmeUREUChtc2cpKTtcbiAgICB9XG4gIH0sXG5cbiAgLy8gU2VuZCBhIGNvbm5lY3Rpb24gZXJyb3IuXG4gIHNlbmRFcnJvcjogZnVuY3Rpb24gKHJlYXNvbiwgb2ZmZW5kaW5nTWVzc2FnZSkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICB2YXIgbXNnID0ge21zZzogJ2Vycm9yJywgcmVhc29uOiByZWFzb259O1xuICAgIGlmIChvZmZlbmRpbmdNZXNzYWdlKVxuICAgICAgbXNnLm9mZmVuZGluZ01lc3NhZ2UgPSBvZmZlbmRpbmdNZXNzYWdlO1xuICAgIHNlbGYuc2VuZChtc2cpO1xuICB9LFxuXG4gIC8vIFByb2Nlc3MgJ21zZycgYXMgYW4gaW5jb21pbmcgbWVzc2FnZS4gQXMgYSBndWFyZCBhZ2FpbnN0XG4gIC8vIHJhY2UgY29uZGl0aW9ucyBkdXJpbmcgcmVjb25uZWN0aW9uLCBpZ25vcmUgdGhlIG1lc3NhZ2UgaWZcbiAgLy8gJ3NvY2tldCcgaXMgbm90IHRoZSBjdXJyZW50bHkgY29ubmVjdGVkIHNvY2tldC5cbiAgLy9cbiAgLy8gV2UgcnVuIHRoZSBtZXNzYWdlcyBmcm9tIHRoZSBjbGllbnQgb25lIGF0IGEgdGltZSwgaW4gdGhlIG9yZGVyXG4gIC8vIGdpdmVuIGJ5IHRoZSBjbGllbnQuIFRoZSBtZXNzYWdlIGhhbmRsZXIgaXMgcGFzc2VkIGFuIGlkZW1wb3RlbnRcbiAgLy8gZnVuY3Rpb24gJ3VuYmxvY2snIHdoaWNoIGl0IG1heSBjYWxsIHRvIGFsbG93IG90aGVyIG1lc3NhZ2VzIHRvXG4gIC8vIGJlZ2luIHJ1bm5pbmcgaW4gcGFyYWxsZWwgaW4gYW5vdGhlciBmaWJlciAoZm9yIGV4YW1wbGUsIGEgbWV0aG9kXG4gIC8vIHRoYXQgd2FudHMgdG8geWllbGQpLiBPdGhlcndpc2UsIGl0IGlzIGF1dG9tYXRpY2FsbHkgdW5ibG9ja2VkXG4gIC8vIHdoZW4gaXQgcmV0dXJucy5cbiAgLy9cbiAgLy8gQWN0dWFsbHksIHdlIGRvbid0IGhhdmUgdG8gJ3RvdGFsbHkgb3JkZXInIHRoZSBtZXNzYWdlcyBpbiB0aGlzXG4gIC8vIHdheSwgYnV0IGl0J3MgdGhlIGVhc2llc3QgdGhpbmcgdGhhdCdzIGNvcnJlY3QuICh1bnN1YiBuZWVkcyB0b1xuICAvLyBiZSBvcmRlcmVkIGFnYWluc3Qgc3ViLCBtZXRob2RzIG5lZWQgdG8gYmUgb3JkZXJlZCBhZ2FpbnN0IGVhY2hcbiAgLy8gb3RoZXIpLlxuICBwcm9jZXNzTWVzc2FnZTogZnVuY3Rpb24gKG1zZ19pbikge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoIXNlbGYuaW5RdWV1ZSkgLy8gd2UgaGF2ZSBiZWVuIGRlc3Ryb3llZC5cbiAgICAgIHJldHVybjtcblxuICAgIC8vIFJlc3BvbmQgdG8gcGluZyBhbmQgcG9uZyBtZXNzYWdlcyBpbW1lZGlhdGVseSB3aXRob3V0IHF1ZXVpbmcuXG4gICAgLy8gSWYgdGhlIG5lZ290aWF0ZWQgRERQIHZlcnNpb24gaXMgXCJwcmUxXCIgd2hpY2ggZGlkbid0IHN1cHBvcnRcbiAgICAvLyBwaW5ncywgcHJlc2VydmUgdGhlIFwicHJlMVwiIGJlaGF2aW9yIG9mIHJlc3BvbmRpbmcgd2l0aCBhIFwiYmFkXG4gICAgLy8gcmVxdWVzdFwiIGZvciB0aGUgdW5rbm93biBtZXNzYWdlcy5cbiAgICAvL1xuICAgIC8vIEZpYmVycyBhcmUgbmVlZGVkIGJlY2F1c2UgaGVhcnRiZWF0cyB1c2UgTWV0ZW9yLnNldFRpbWVvdXQsIHdoaWNoXG4gICAgLy8gbmVlZHMgYSBGaWJlci4gV2UgY291bGQgYWN0dWFsbHkgdXNlIHJlZ3VsYXIgc2V0VGltZW91dCBhbmQgYXZvaWRcbiAgICAvLyB0aGVzZSBuZXcgZmliZXJzLCBidXQgaXQgaXMgZWFzaWVyIHRvIGp1c3QgbWFrZSBldmVyeXRoaW5nIHVzZVxuICAgIC8vIE1ldGVvci5zZXRUaW1lb3V0IGFuZCBub3QgdGhpbmsgdG9vIGhhcmQuXG4gICAgLy9cbiAgICAvLyBBbnkgbWVzc2FnZSBjb3VudHMgYXMgcmVjZWl2aW5nIGEgcG9uZywgYXMgaXQgZGVtb25zdHJhdGVzIHRoYXRcbiAgICAvLyB0aGUgY2xpZW50IGlzIHN0aWxsIGFsaXZlLlxuICAgIGlmIChzZWxmLmhlYXJ0YmVhdCkge1xuICAgICAgRmliZXIoZnVuY3Rpb24gKCkge1xuICAgICAgICBzZWxmLmhlYXJ0YmVhdC5tZXNzYWdlUmVjZWl2ZWQoKTtcbiAgICAgIH0pLnJ1bigpO1xuICAgIH1cblxuICAgIGlmIChzZWxmLnZlcnNpb24gIT09ICdwcmUxJyAmJiBtc2dfaW4ubXNnID09PSAncGluZycpIHtcbiAgICAgIGlmIChzZWxmLl9yZXNwb25kVG9QaW5ncylcbiAgICAgICAgc2VsZi5zZW5kKHttc2c6IFwicG9uZ1wiLCBpZDogbXNnX2luLmlkfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChzZWxmLnZlcnNpb24gIT09ICdwcmUxJyAmJiBtc2dfaW4ubXNnID09PSAncG9uZycpIHtcbiAgICAgIC8vIFNpbmNlIGV2ZXJ5dGhpbmcgaXMgYSBwb25nLCB0aGVyZSBpcyBub3RoaW5nIHRvIGRvXG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgc2VsZi5pblF1ZXVlLnB1c2gobXNnX2luKTtcbiAgICBpZiAoc2VsZi53b3JrZXJSdW5uaW5nKVxuICAgICAgcmV0dXJuO1xuICAgIHNlbGYud29ya2VyUnVubmluZyA9IHRydWU7XG5cbiAgICB2YXIgcHJvY2Vzc05leHQgPSBmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgbXNnID0gc2VsZi5pblF1ZXVlICYmIHNlbGYuaW5RdWV1ZS5zaGlmdCgpO1xuICAgICAgaWYgKCFtc2cpIHtcbiAgICAgICAgc2VsZi53b3JrZXJSdW5uaW5nID0gZmFsc2U7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgRmliZXIoZnVuY3Rpb24gKCkge1xuICAgICAgICB2YXIgYmxvY2tlZCA9IHRydWU7XG5cbiAgICAgICAgdmFyIHVuYmxvY2sgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgaWYgKCFibG9ja2VkKVxuICAgICAgICAgICAgcmV0dXJuOyAvLyBpZGVtcG90ZW50XG4gICAgICAgICAgYmxvY2tlZCA9IGZhbHNlO1xuICAgICAgICAgIHByb2Nlc3NOZXh0KCk7XG4gICAgICAgIH07XG5cbiAgICAgICAgc2VsZi5zZXJ2ZXIub25NZXNzYWdlSG9vay5lYWNoKGZ1bmN0aW9uIChjYWxsYmFjaykge1xuICAgICAgICAgIGNhbGxiYWNrKG1zZywgc2VsZik7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGlmIChfLmhhcyhzZWxmLnByb3RvY29sX2hhbmRsZXJzLCBtc2cubXNnKSlcbiAgICAgICAgICBzZWxmLnByb3RvY29sX2hhbmRsZXJzW21zZy5tc2ddLmNhbGwoc2VsZiwgbXNnLCB1bmJsb2NrKTtcbiAgICAgICAgZWxzZVxuICAgICAgICAgIHNlbGYuc2VuZEVycm9yKCdCYWQgcmVxdWVzdCcsIG1zZyk7XG4gICAgICAgIHVuYmxvY2soKTsgLy8gaW4gY2FzZSB0aGUgaGFuZGxlciBkaWRuJ3QgYWxyZWFkeSBkbyBpdFxuICAgICAgfSkucnVuKCk7XG4gICAgfTtcblxuICAgIHByb2Nlc3NOZXh0KCk7XG4gIH0sXG5cbiAgcHJvdG9jb2xfaGFuZGxlcnM6IHtcbiAgICBzdWI6IGZ1bmN0aW9uIChtc2csIHVuYmxvY2spIHtcbiAgICAgIHZhciBzZWxmID0gdGhpcztcblxuICAgICAgLy8gY2FjaGVVbmJsb2NrIHRlbXBvcmFybHksIHNvIHdlIGNhbiBjYXB0dXJlIGl0IGxhdGVyXG4gICAgICAvLyB3ZSB3aWxsIHVzZSB1bmJsb2NrIGluIGN1cnJlbnQgZXZlbnRMb29wLCBzbyB0aGlzIGlzIHNhZmVcbiAgICAgIHNlbGYuY2FjaGVkVW5ibG9jayA9IHVuYmxvY2s7XG5cbiAgICAgIC8vIHJlamVjdCBtYWxmb3JtZWQgbWVzc2FnZXNcbiAgICAgIGlmICh0eXBlb2YgKG1zZy5pZCkgIT09IFwic3RyaW5nXCIgfHxcbiAgICAgICAgICB0eXBlb2YgKG1zZy5uYW1lKSAhPT0gXCJzdHJpbmdcIiB8fFxuICAgICAgICAgICgoJ3BhcmFtcycgaW4gbXNnKSAmJiAhKG1zZy5wYXJhbXMgaW5zdGFuY2VvZiBBcnJheSkpKSB7XG4gICAgICAgIHNlbGYuc2VuZEVycm9yKFwiTWFsZm9ybWVkIHN1YnNjcmlwdGlvblwiLCBtc2cpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGlmICghc2VsZi5zZXJ2ZXIucHVibGlzaF9oYW5kbGVyc1ttc2cubmFtZV0pIHtcbiAgICAgICAgc2VsZi5zZW5kKHtcbiAgICAgICAgICBtc2c6ICdub3N1YicsIGlkOiBtc2cuaWQsXG4gICAgICAgICAgZXJyb3I6IG5ldyBNZXRlb3IuRXJyb3IoNDA0LCBgU3Vic2NyaXB0aW9uICcke21zZy5uYW1lfScgbm90IGZvdW5kYCl9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBpZiAoc2VsZi5fbmFtZWRTdWJzLmhhcyhtc2cuaWQpKVxuICAgICAgICAvLyBzdWJzIGFyZSBpZGVtcG90ZW50LCBvciByYXRoZXIsIHRoZXkgYXJlIGlnbm9yZWQgaWYgYSBzdWJcbiAgICAgICAgLy8gd2l0aCB0aGF0IGlkIGFscmVhZHkgZXhpc3RzLiB0aGlzIGlzIGltcG9ydGFudCBkdXJpbmdcbiAgICAgICAgLy8gcmVjb25uZWN0LlxuICAgICAgICByZXR1cm47XG5cbiAgICAgIC8vIFhYWCBJdCdkIGJlIG11Y2ggYmV0dGVyIGlmIHdlIGhhZCBnZW5lcmljIGhvb2tzIHdoZXJlIGFueSBwYWNrYWdlIGNhblxuICAgICAgLy8gaG9vayBpbnRvIHN1YnNjcmlwdGlvbiBoYW5kbGluZywgYnV0IGluIHRoZSBtZWFuIHdoaWxlIHdlIHNwZWNpYWwgY2FzZVxuICAgICAgLy8gZGRwLXJhdGUtbGltaXRlciBwYWNrYWdlLiBUaGlzIGlzIGFsc28gZG9uZSBmb3Igd2VhayByZXF1aXJlbWVudHMgdG9cbiAgICAgIC8vIGFkZCB0aGUgZGRwLXJhdGUtbGltaXRlciBwYWNrYWdlIGluIGNhc2Ugd2UgZG9uJ3QgaGF2ZSBBY2NvdW50cy4gQVxuICAgICAgLy8gdXNlciB0cnlpbmcgdG8gdXNlIHRoZSBkZHAtcmF0ZS1saW1pdGVyIG11c3QgZXhwbGljaXRseSByZXF1aXJlIGl0LlxuICAgICAgaWYgKFBhY2thZ2VbJ2RkcC1yYXRlLWxpbWl0ZXInXSkge1xuICAgICAgICB2YXIgRERQUmF0ZUxpbWl0ZXIgPSBQYWNrYWdlWydkZHAtcmF0ZS1saW1pdGVyJ10uRERQUmF0ZUxpbWl0ZXI7XG4gICAgICAgIHZhciByYXRlTGltaXRlcklucHV0ID0ge1xuICAgICAgICAgIHVzZXJJZDogc2VsZi51c2VySWQsXG4gICAgICAgICAgY2xpZW50QWRkcmVzczogc2VsZi5jb25uZWN0aW9uSGFuZGxlLmNsaWVudEFkZHJlc3MsXG4gICAgICAgICAgdHlwZTogXCJzdWJzY3JpcHRpb25cIixcbiAgICAgICAgICBuYW1lOiBtc2cubmFtZSxcbiAgICAgICAgICBjb25uZWN0aW9uSWQ6IHNlbGYuaWRcbiAgICAgICAgfTtcblxuICAgICAgICBERFBSYXRlTGltaXRlci5faW5jcmVtZW50KHJhdGVMaW1pdGVySW5wdXQpO1xuICAgICAgICB2YXIgcmF0ZUxpbWl0UmVzdWx0ID0gRERQUmF0ZUxpbWl0ZXIuX2NoZWNrKHJhdGVMaW1pdGVySW5wdXQpO1xuICAgICAgICBpZiAoIXJhdGVMaW1pdFJlc3VsdC5hbGxvd2VkKSB7XG4gICAgICAgICAgc2VsZi5zZW5kKHtcbiAgICAgICAgICAgIG1zZzogJ25vc3ViJywgaWQ6IG1zZy5pZCxcbiAgICAgICAgICAgIGVycm9yOiBuZXcgTWV0ZW9yLkVycm9yKFxuICAgICAgICAgICAgICAndG9vLW1hbnktcmVxdWVzdHMnLFxuICAgICAgICAgICAgICBERFBSYXRlTGltaXRlci5nZXRFcnJvck1lc3NhZ2UocmF0ZUxpbWl0UmVzdWx0KSxcbiAgICAgICAgICAgICAge3RpbWVUb1Jlc2V0OiByYXRlTGltaXRSZXN1bHQudGltZVRvUmVzZXR9KVxuICAgICAgICAgIH0pO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICB2YXIgaGFuZGxlciA9IHNlbGYuc2VydmVyLnB1Ymxpc2hfaGFuZGxlcnNbbXNnLm5hbWVdO1xuXG4gICAgICBzZWxmLl9zdGFydFN1YnNjcmlwdGlvbihoYW5kbGVyLCBtc2cuaWQsIG1zZy5wYXJhbXMsIG1zZy5uYW1lKTtcblxuICAgICAgLy8gY2xlYW5pbmcgY2FjaGVkIHVuYmxvY2tcbiAgICAgIHNlbGYuY2FjaGVkVW5ibG9jayA9IG51bGw7XG4gICAgfSxcblxuICAgIHVuc3ViOiBmdW5jdGlvbiAobXNnKSB7XG4gICAgICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgICAgIHNlbGYuX3N0b3BTdWJzY3JpcHRpb24obXNnLmlkKTtcbiAgICB9LFxuXG4gICAgbWV0aG9kOiBmdW5jdGlvbiAobXNnLCB1bmJsb2NrKSB7XG4gICAgICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgICAgIC8vIFJlamVjdCBtYWxmb3JtZWQgbWVzc2FnZXMuXG4gICAgICAvLyBGb3Igbm93LCB3ZSBzaWxlbnRseSBpZ25vcmUgdW5rbm93biBhdHRyaWJ1dGVzLFxuICAgICAgLy8gZm9yIGZvcndhcmRzIGNvbXBhdGliaWxpdHkuXG4gICAgICBpZiAodHlwZW9mIChtc2cuaWQpICE9PSBcInN0cmluZ1wiIHx8XG4gICAgICAgICAgdHlwZW9mIChtc2cubWV0aG9kKSAhPT0gXCJzdHJpbmdcIiB8fFxuICAgICAgICAgICgoJ3BhcmFtcycgaW4gbXNnKSAmJiAhKG1zZy5wYXJhbXMgaW5zdGFuY2VvZiBBcnJheSkpIHx8XG4gICAgICAgICAgKCgncmFuZG9tU2VlZCcgaW4gbXNnKSAmJiAodHlwZW9mIG1zZy5yYW5kb21TZWVkICE9PSBcInN0cmluZ1wiKSkpIHtcbiAgICAgICAgc2VsZi5zZW5kRXJyb3IoXCJNYWxmb3JtZWQgbWV0aG9kIGludm9jYXRpb25cIiwgbXNnKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICB2YXIgcmFuZG9tU2VlZCA9IG1zZy5yYW5kb21TZWVkIHx8IG51bGw7XG5cbiAgICAgIC8vIFNldCB1cCB0byBtYXJrIHRoZSBtZXRob2QgYXMgc2F0aXNmaWVkIG9uY2UgYWxsIG9ic2VydmVyc1xuICAgICAgLy8gKGFuZCBzdWJzY3JpcHRpb25zKSBoYXZlIHJlYWN0ZWQgdG8gYW55IHdyaXRlcyB0aGF0IHdlcmVcbiAgICAgIC8vIGRvbmUuXG4gICAgICB2YXIgZmVuY2UgPSBuZXcgRERQU2VydmVyLl9Xcml0ZUZlbmNlO1xuICAgICAgZmVuY2Uub25BbGxDb21taXR0ZWQoZnVuY3Rpb24gKCkge1xuICAgICAgICAvLyBSZXRpcmUgdGhlIGZlbmNlIHNvIHRoYXQgZnV0dXJlIHdyaXRlcyBhcmUgYWxsb3dlZC5cbiAgICAgICAgLy8gVGhpcyBtZWFucyB0aGF0IGNhbGxiYWNrcyBsaWtlIHRpbWVycyBhcmUgZnJlZSB0byB1c2VcbiAgICAgICAgLy8gdGhlIGZlbmNlLCBhbmQgaWYgdGhleSBmaXJlIGJlZm9yZSBpdCdzIGFybWVkIChmb3JcbiAgICAgICAgLy8gZXhhbXBsZSwgYmVjYXVzZSB0aGUgbWV0aG9kIHdhaXRzIGZvciB0aGVtKSB0aGVpclxuICAgICAgICAvLyB3cml0ZXMgd2lsbCBiZSBpbmNsdWRlZCBpbiB0aGUgZmVuY2UuXG4gICAgICAgIGZlbmNlLnJldGlyZSgpO1xuICAgICAgICBzZWxmLnNlbmQoe1xuICAgICAgICAgIG1zZzogJ3VwZGF0ZWQnLCBtZXRob2RzOiBbbXNnLmlkXX0pO1xuICAgICAgfSk7XG5cbiAgICAgIC8vIEZpbmQgdGhlIGhhbmRsZXJcbiAgICAgIHZhciBoYW5kbGVyID0gc2VsZi5zZXJ2ZXIubWV0aG9kX2hhbmRsZXJzW21zZy5tZXRob2RdO1xuICAgICAgaWYgKCFoYW5kbGVyKSB7XG4gICAgICAgIHNlbGYuc2VuZCh7XG4gICAgICAgICAgbXNnOiAncmVzdWx0JywgaWQ6IG1zZy5pZCxcbiAgICAgICAgICBlcnJvcjogbmV3IE1ldGVvci5FcnJvcig0MDQsIGBNZXRob2QgJyR7bXNnLm1ldGhvZH0nIG5vdCBmb3VuZGApfSk7XG4gICAgICAgIGZlbmNlLmFybSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIHZhciBzZXRVc2VySWQgPSBmdW5jdGlvbih1c2VySWQpIHtcbiAgICAgICAgc2VsZi5fc2V0VXNlcklkKHVzZXJJZCk7XG4gICAgICB9O1xuXG4gICAgICB2YXIgaW52b2NhdGlvbiA9IG5ldyBERFBDb21tb24uTWV0aG9kSW52b2NhdGlvbih7XG4gICAgICAgIGlzU2ltdWxhdGlvbjogZmFsc2UsXG4gICAgICAgIHVzZXJJZDogc2VsZi51c2VySWQsXG4gICAgICAgIHNldFVzZXJJZDogc2V0VXNlcklkLFxuICAgICAgICB1bmJsb2NrOiB1bmJsb2NrLFxuICAgICAgICBjb25uZWN0aW9uOiBzZWxmLmNvbm5lY3Rpb25IYW5kbGUsXG4gICAgICAgIHJhbmRvbVNlZWQ6IHJhbmRvbVNlZWRcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBwcm9taXNlID0gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICAvLyBYWFggSXQnZCBiZSBiZXR0ZXIgaWYgd2UgY291bGQgaG9vayBpbnRvIG1ldGhvZCBoYW5kbGVycyBiZXR0ZXIgYnV0XG4gICAgICAgIC8vIGZvciBub3csIHdlIG5lZWQgdG8gY2hlY2sgaWYgdGhlIGRkcC1yYXRlLWxpbWl0ZXIgZXhpc3RzIHNpbmNlIHdlXG4gICAgICAgIC8vIGhhdmUgYSB3ZWFrIHJlcXVpcmVtZW50IGZvciB0aGUgZGRwLXJhdGUtbGltaXRlciBwYWNrYWdlIHRvIGJlIGFkZGVkXG4gICAgICAgIC8vIHRvIG91ciBhcHBsaWNhdGlvbi5cbiAgICAgICAgaWYgKFBhY2thZ2VbJ2RkcC1yYXRlLWxpbWl0ZXInXSkge1xuICAgICAgICAgIHZhciBERFBSYXRlTGltaXRlciA9IFBhY2thZ2VbJ2RkcC1yYXRlLWxpbWl0ZXInXS5ERFBSYXRlTGltaXRlcjtcbiAgICAgICAgICB2YXIgcmF0ZUxpbWl0ZXJJbnB1dCA9IHtcbiAgICAgICAgICAgIHVzZXJJZDogc2VsZi51c2VySWQsXG4gICAgICAgICAgICBjbGllbnRBZGRyZXNzOiBzZWxmLmNvbm5lY3Rpb25IYW5kbGUuY2xpZW50QWRkcmVzcyxcbiAgICAgICAgICAgIHR5cGU6IFwibWV0aG9kXCIsXG4gICAgICAgICAgICBuYW1lOiBtc2cubWV0aG9kLFxuICAgICAgICAgICAgY29ubmVjdGlvbklkOiBzZWxmLmlkXG4gICAgICAgICAgfTtcbiAgICAgICAgICBERFBSYXRlTGltaXRlci5faW5jcmVtZW50KHJhdGVMaW1pdGVySW5wdXQpO1xuICAgICAgICAgIHZhciByYXRlTGltaXRSZXN1bHQgPSBERFBSYXRlTGltaXRlci5fY2hlY2socmF0ZUxpbWl0ZXJJbnB1dClcbiAgICAgICAgICBpZiAoIXJhdGVMaW1pdFJlc3VsdC5hbGxvd2VkKSB7XG4gICAgICAgICAgICByZWplY3QobmV3IE1ldGVvci5FcnJvcihcbiAgICAgICAgICAgICAgXCJ0b28tbWFueS1yZXF1ZXN0c1wiLFxuICAgICAgICAgICAgICBERFBSYXRlTGltaXRlci5nZXRFcnJvck1lc3NhZ2UocmF0ZUxpbWl0UmVzdWx0KSxcbiAgICAgICAgICAgICAge3RpbWVUb1Jlc2V0OiByYXRlTGltaXRSZXN1bHQudGltZVRvUmVzZXR9XG4gICAgICAgICAgICApKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBnZXRDdXJyZW50TWV0aG9kSW52b2NhdGlvblJlc3VsdCA9ICgpID0+IHtcbiAgICAgICAgICBjb25zdCBjdXJyZW50Q29udGV4dCA9IEREUC5fQ3VycmVudE1ldGhvZEludm9jYXRpb24uX3NldE5ld0NvbnRleHRBbmRHZXRDdXJyZW50KFxuICAgICAgICAgICAgaW52b2NhdGlvblxuICAgICAgICAgICk7XG5cbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgbGV0IHJlc3VsdDtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdE9yVGhlbmFibGUgPSBtYXliZUF1ZGl0QXJndW1lbnRDaGVja3MoXG4gICAgICAgICAgICAgIGhhbmRsZXIsXG4gICAgICAgICAgICAgIGludm9jYXRpb24sXG4gICAgICAgICAgICAgIG1zZy5wYXJhbXMsXG4gICAgICAgICAgICAgIFwiY2FsbCB0byAnXCIgKyBtc2cubWV0aG9kICsgXCInXCJcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBjb25zdCBpc1RoZW5hYmxlID1cbiAgICAgICAgICAgICAgcmVzdWx0T3JUaGVuYWJsZSAmJiB0eXBlb2YgcmVzdWx0T3JUaGVuYWJsZS50aGVuID09PSAnZnVuY3Rpb24nO1xuICAgICAgICAgICAgaWYgKGlzVGhlbmFibGUpIHtcbiAgICAgICAgICAgICAgcmVzdWx0ID0gUHJvbWlzZS5hd2FpdChyZXN1bHRPclRoZW5hYmxlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHJlc3VsdCA9IHJlc3VsdE9yVGhlbmFibGU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICBERFAuX0N1cnJlbnRNZXRob2RJbnZvY2F0aW9uLl9zZXQoY3VycmVudENvbnRleHQpO1xuICAgICAgICAgIH1cbiAgICAgICAgfTtcblxuICAgICAgICByZXNvbHZlKEREUFNlcnZlci5fQ3VycmVudFdyaXRlRmVuY2Uud2l0aFZhbHVlKGZlbmNlLCBnZXRDdXJyZW50TWV0aG9kSW52b2NhdGlvblJlc3VsdCkpO1xuICAgICAgfSk7XG5cbiAgICAgIGZ1bmN0aW9uIGZpbmlzaCgpIHtcbiAgICAgICAgZmVuY2UuYXJtKCk7XG4gICAgICAgIHVuYmxvY2soKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcGF5bG9hZCA9IHtcbiAgICAgICAgbXNnOiBcInJlc3VsdFwiLFxuICAgICAgICBpZDogbXNnLmlkXG4gICAgICB9O1xuXG4gICAgICBwcm9taXNlLnRoZW4ocmVzdWx0ID0+IHtcbiAgICAgICAgZmluaXNoKCk7XG4gICAgICAgIGlmIChyZXN1bHQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIHBheWxvYWQucmVzdWx0ID0gcmVzdWx0O1xuICAgICAgICB9XG4gICAgICAgIHNlbGYuc2VuZChwYXlsb2FkKTtcbiAgICAgIH0sIChleGNlcHRpb24pID0+IHtcbiAgICAgICAgZmluaXNoKCk7XG4gICAgICAgIHBheWxvYWQuZXJyb3IgPSB3cmFwSW50ZXJuYWxFeGNlcHRpb24oXG4gICAgICAgICAgZXhjZXB0aW9uLFxuICAgICAgICAgIGB3aGlsZSBpbnZva2luZyBtZXRob2QgJyR7bXNnLm1ldGhvZH0nYFxuICAgICAgICApO1xuICAgICAgICBzZWxmLnNlbmQocGF5bG9hZCk7XG4gICAgICB9KTtcbiAgICB9XG4gIH0sXG5cbiAgX2VhY2hTdWI6IGZ1bmN0aW9uIChmKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHNlbGYuX25hbWVkU3Vicy5mb3JFYWNoKGYpO1xuICAgIHNlbGYuX3VuaXZlcnNhbFN1YnMuZm9yRWFjaChmKTtcbiAgfSxcblxuICBfZGlmZkNvbGxlY3Rpb25WaWV3czogZnVuY3Rpb24gKGJlZm9yZUNWcykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBEaWZmU2VxdWVuY2UuZGlmZk1hcHMoYmVmb3JlQ1ZzLCBzZWxmLmNvbGxlY3Rpb25WaWV3cywge1xuICAgICAgYm90aDogZnVuY3Rpb24gKGNvbGxlY3Rpb25OYW1lLCBsZWZ0VmFsdWUsIHJpZ2h0VmFsdWUpIHtcbiAgICAgICAgcmlnaHRWYWx1ZS5kaWZmKGxlZnRWYWx1ZSk7XG4gICAgICB9LFxuICAgICAgcmlnaHRPbmx5OiBmdW5jdGlvbiAoY29sbGVjdGlvbk5hbWUsIHJpZ2h0VmFsdWUpIHtcbiAgICAgICAgcmlnaHRWYWx1ZS5kb2N1bWVudHMuZm9yRWFjaChmdW5jdGlvbiAoZG9jVmlldywgaWQpIHtcbiAgICAgICAgICBzZWxmLnNlbmRBZGRlZChjb2xsZWN0aW9uTmFtZSwgaWQsIGRvY1ZpZXcuZ2V0RmllbGRzKCkpO1xuICAgICAgICB9KTtcbiAgICAgIH0sXG4gICAgICBsZWZ0T25seTogZnVuY3Rpb24gKGNvbGxlY3Rpb25OYW1lLCBsZWZ0VmFsdWUpIHtcbiAgICAgICAgbGVmdFZhbHVlLmRvY3VtZW50cy5mb3JFYWNoKGZ1bmN0aW9uIChkb2MsIGlkKSB7XG4gICAgICAgICAgc2VsZi5zZW5kUmVtb3ZlZChjb2xsZWN0aW9uTmFtZSwgaWQpO1xuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSxcblxuICAvLyBTZXRzIHRoZSBjdXJyZW50IHVzZXIgaWQgaW4gYWxsIGFwcHJvcHJpYXRlIGNvbnRleHRzIGFuZCByZXJ1bnNcbiAgLy8gYWxsIHN1YnNjcmlwdGlvbnNcbiAgX3NldFVzZXJJZDogZnVuY3Rpb24odXNlcklkKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gICAgaWYgKHVzZXJJZCAhPT0gbnVsbCAmJiB0eXBlb2YgdXNlcklkICE9PSBcInN0cmluZ1wiKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwic2V0VXNlcklkIG11c3QgYmUgY2FsbGVkIG9uIHN0cmluZyBvciBudWxsLCBub3QgXCIgK1xuICAgICAgICAgICAgICAgICAgICAgIHR5cGVvZiB1c2VySWQpO1xuXG4gICAgLy8gUHJldmVudCBuZXdseS1jcmVhdGVkIHVuaXZlcnNhbCBzdWJzY3JpcHRpb25zIGZyb20gYmVpbmcgYWRkZWQgdG8gb3VyXG4gICAgLy8gc2Vzc2lvbi4gVGhleSB3aWxsIGJlIGZvdW5kIGJlbG93IHdoZW4gd2UgY2FsbCBzdGFydFVuaXZlcnNhbFN1YnMuXG4gICAgLy9cbiAgICAvLyAoV2UgZG9uJ3QgaGF2ZSB0byB3b3JyeSBhYm91dCBuYW1lZCBzdWJzY3JpcHRpb25zLCBiZWNhdXNlIHdlIG9ubHkgYWRkXG4gICAgLy8gdGhlbSB3aGVuIHdlIHByb2Nlc3MgYSAnc3ViJyBtZXNzYWdlLiBXZSBhcmUgY3VycmVudGx5IHByb2Nlc3NpbmcgYVxuICAgIC8vICdtZXRob2QnIG1lc3NhZ2UsIGFuZCB0aGUgbWV0aG9kIGRpZCBub3QgdW5ibG9jaywgYmVjYXVzZSBpdCBpcyBpbGxlZ2FsXG4gICAgLy8gdG8gY2FsbCBzZXRVc2VySWQgYWZ0ZXIgdW5ibG9jay4gVGh1cyB3ZSBjYW5ub3QgYmUgY29uY3VycmVudGx5IGFkZGluZyBhXG4gICAgLy8gbmV3IG5hbWVkIHN1YnNjcmlwdGlvbikuXG4gICAgc2VsZi5fZG9udFN0YXJ0TmV3VW5pdmVyc2FsU3VicyA9IHRydWU7XG5cbiAgICAvLyBQcmV2ZW50IGN1cnJlbnQgc3VicyBmcm9tIHVwZGF0aW5nIG91ciBjb2xsZWN0aW9uVmlld3MgYW5kIGNhbGwgdGhlaXJcbiAgICAvLyBzdG9wIGNhbGxiYWNrcy4gVGhpcyBtYXkgeWllbGQuXG4gICAgc2VsZi5fZWFjaFN1YihmdW5jdGlvbiAoc3ViKSB7XG4gICAgICBzdWIuX2RlYWN0aXZhdGUoKTtcbiAgICB9KTtcblxuICAgIC8vIEFsbCBzdWJzIHNob3VsZCBub3cgYmUgZGVhY3RpdmF0ZWQuIFN0b3Agc2VuZGluZyBtZXNzYWdlcyB0byB0aGUgY2xpZW50LFxuICAgIC8vIHNhdmUgdGhlIHN0YXRlIG9mIHRoZSBwdWJsaXNoZWQgY29sbGVjdGlvbnMsIHJlc2V0IHRvIGFuIGVtcHR5IHZpZXcsIGFuZFxuICAgIC8vIHVwZGF0ZSB0aGUgdXNlcklkLlxuICAgIHNlbGYuX2lzU2VuZGluZyA9IGZhbHNlO1xuICAgIHZhciBiZWZvcmVDVnMgPSBzZWxmLmNvbGxlY3Rpb25WaWV3cztcbiAgICBzZWxmLmNvbGxlY3Rpb25WaWV3cyA9IG5ldyBNYXAoKTtcbiAgICBzZWxmLnVzZXJJZCA9IHVzZXJJZDtcblxuICAgIC8vIF9zZXRVc2VySWQgaXMgbm9ybWFsbHkgY2FsbGVkIGZyb20gYSBNZXRlb3IgbWV0aG9kIHdpdGhcbiAgICAvLyBERFAuX0N1cnJlbnRNZXRob2RJbnZvY2F0aW9uIHNldC4gQnV0IEREUC5fQ3VycmVudE1ldGhvZEludm9jYXRpb24gaXMgbm90XG4gICAgLy8gZXhwZWN0ZWQgdG8gYmUgc2V0IGluc2lkZSBhIHB1Ymxpc2ggZnVuY3Rpb24sIHNvIHdlIHRlbXBvcmFyeSB1bnNldCBpdC5cbiAgICAvLyBJbnNpZGUgYSBwdWJsaXNoIGZ1bmN0aW9uIEREUC5fQ3VycmVudFB1YmxpY2F0aW9uSW52b2NhdGlvbiBpcyBzZXQuXG4gICAgRERQLl9DdXJyZW50TWV0aG9kSW52b2NhdGlvbi53aXRoVmFsdWUodW5kZWZpbmVkLCBmdW5jdGlvbiAoKSB7XG4gICAgICAvLyBTYXZlIHRoZSBvbGQgbmFtZWQgc3VicywgYW5kIHJlc2V0IHRvIGhhdmluZyBubyBzdWJzY3JpcHRpb25zLlxuICAgICAgdmFyIG9sZE5hbWVkU3VicyA9IHNlbGYuX25hbWVkU3VicztcbiAgICAgIHNlbGYuX25hbWVkU3VicyA9IG5ldyBNYXAoKTtcbiAgICAgIHNlbGYuX3VuaXZlcnNhbFN1YnMgPSBbXTtcblxuICAgICAgb2xkTmFtZWRTdWJzLmZvckVhY2goZnVuY3Rpb24gKHN1Yiwgc3Vic2NyaXB0aW9uSWQpIHtcbiAgICAgICAgdmFyIG5ld1N1YiA9IHN1Yi5fcmVjcmVhdGUoKTtcbiAgICAgICAgc2VsZi5fbmFtZWRTdWJzLnNldChzdWJzY3JpcHRpb25JZCwgbmV3U3ViKTtcbiAgICAgICAgLy8gbmI6IGlmIHRoZSBoYW5kbGVyIHRocm93cyBvciBjYWxscyB0aGlzLmVycm9yKCksIGl0IHdpbGwgaW4gZmFjdFxuICAgICAgICAvLyBpbW1lZGlhdGVseSBzZW5kIGl0cyAnbm9zdWInLiBUaGlzIGlzIE9LLCB0aG91Z2guXG4gICAgICAgIG5ld1N1Yi5fcnVuSGFuZGxlcigpO1xuICAgICAgfSk7XG5cbiAgICAgIC8vIEFsbG93IG5ld2x5LWNyZWF0ZWQgdW5pdmVyc2FsIHN1YnMgdG8gYmUgc3RhcnRlZCBvbiBvdXIgY29ubmVjdGlvbiBpblxuICAgICAgLy8gcGFyYWxsZWwgd2l0aCB0aGUgb25lcyB3ZSdyZSBzcGlubmluZyB1cCBoZXJlLCBhbmQgc3BpbiB1cCB1bml2ZXJzYWxcbiAgICAgIC8vIHN1YnMuXG4gICAgICBzZWxmLl9kb250U3RhcnROZXdVbml2ZXJzYWxTdWJzID0gZmFsc2U7XG4gICAgICBzZWxmLnN0YXJ0VW5pdmVyc2FsU3VicygpO1xuICAgIH0pO1xuXG4gICAgLy8gU3RhcnQgc2VuZGluZyBtZXNzYWdlcyBhZ2FpbiwgYmVnaW5uaW5nIHdpdGggdGhlIGRpZmYgZnJvbSB0aGUgcHJldmlvdXNcbiAgICAvLyBzdGF0ZSBvZiB0aGUgd29ybGQgdG8gdGhlIGN1cnJlbnQgc3RhdGUuIE5vIHlpZWxkcyBhcmUgYWxsb3dlZCBkdXJpbmdcbiAgICAvLyB0aGlzIGRpZmYsIHNvIHRoYXQgb3RoZXIgY2hhbmdlcyBjYW5ub3QgaW50ZXJsZWF2ZS5cbiAgICBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG4gICAgICBzZWxmLl9pc1NlbmRpbmcgPSB0cnVlO1xuICAgICAgc2VsZi5fZGlmZkNvbGxlY3Rpb25WaWV3cyhiZWZvcmVDVnMpO1xuICAgICAgaWYgKCFfLmlzRW1wdHkoc2VsZi5fcGVuZGluZ1JlYWR5KSkge1xuICAgICAgICBzZWxmLnNlbmRSZWFkeShzZWxmLl9wZW5kaW5nUmVhZHkpO1xuICAgICAgICBzZWxmLl9wZW5kaW5nUmVhZHkgPSBbXTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSxcblxuICBfc3RhcnRTdWJzY3JpcHRpb246IGZ1bmN0aW9uIChoYW5kbGVyLCBzdWJJZCwgcGFyYW1zLCBuYW1lKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gICAgdmFyIHN1YiA9IG5ldyBTdWJzY3JpcHRpb24oXG4gICAgICBzZWxmLCBoYW5kbGVyLCBzdWJJZCwgcGFyYW1zLCBuYW1lKTtcblxuICAgIGxldCB1bmJsb2NrSGFuZGVyID0gc2VsZi5jYWNoZWRVbmJsb2NrO1xuICAgIC8vIF9zdGFydFN1YnNjcmlwdGlvbiBtYXkgY2FsbCBmcm9tIGEgbG90IHBsYWNlc1xuICAgIC8vIHNvIGNhY2hlZFVuYmxvY2sgbWlnaHQgYmUgbnVsbCBpbiBzb21lY2FzZXNcbiAgICAvLyBhc3NpZ24gdGhlIGNhY2hlZFVuYmxvY2tcbiAgICBzdWIudW5ibG9jayA9IHVuYmxvY2tIYW5kZXIgfHwgKCgpID0+IHt9KTtcblxuICAgIGlmIChzdWJJZClcbiAgICAgIHNlbGYuX25hbWVkU3Vicy5zZXQoc3ViSWQsIHN1Yik7XG4gICAgZWxzZVxuICAgICAgc2VsZi5fdW5pdmVyc2FsU3Vicy5wdXNoKHN1Yik7XG5cbiAgICBzdWIuX3J1bkhhbmRsZXIoKTtcbiAgfSxcblxuICAvLyBUZWFyIGRvd24gc3BlY2lmaWVkIHN1YnNjcmlwdGlvblxuICBfc3RvcFN1YnNjcmlwdGlvbjogZnVuY3Rpb24gKHN1YklkLCBlcnJvcikge1xuICAgIHZhciBzZWxmID0gdGhpcztcblxuICAgIHZhciBzdWJOYW1lID0gbnVsbDtcbiAgICBpZiAoc3ViSWQpIHtcbiAgICAgIHZhciBtYXliZVN1YiA9IHNlbGYuX25hbWVkU3Vicy5nZXQoc3ViSWQpO1xuICAgICAgaWYgKG1heWJlU3ViKSB7XG4gICAgICAgIHN1Yk5hbWUgPSBtYXliZVN1Yi5fbmFtZTtcbiAgICAgICAgbWF5YmVTdWIuX3JlbW92ZUFsbERvY3VtZW50cygpO1xuICAgICAgICBtYXliZVN1Yi5fZGVhY3RpdmF0ZSgpO1xuICAgICAgICBzZWxmLl9uYW1lZFN1YnMuZGVsZXRlKHN1YklkKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB2YXIgcmVzcG9uc2UgPSB7bXNnOiAnbm9zdWInLCBpZDogc3ViSWR9O1xuXG4gICAgaWYgKGVycm9yKSB7XG4gICAgICByZXNwb25zZS5lcnJvciA9IHdyYXBJbnRlcm5hbEV4Y2VwdGlvbihcbiAgICAgICAgZXJyb3IsXG4gICAgICAgIHN1Yk5hbWUgPyAoXCJmcm9tIHN1YiBcIiArIHN1Yk5hbWUgKyBcIiBpZCBcIiArIHN1YklkKVxuICAgICAgICAgIDogKFwiZnJvbSBzdWIgaWQgXCIgKyBzdWJJZCkpO1xuICAgIH1cblxuICAgIHNlbGYuc2VuZChyZXNwb25zZSk7XG4gIH0sXG5cbiAgLy8gVGVhciBkb3duIGFsbCBzdWJzY3JpcHRpb25zLiBOb3RlIHRoYXQgdGhpcyBkb2VzIE5PVCBzZW5kIHJlbW92ZWQgb3Igbm9zdWJcbiAgLy8gbWVzc2FnZXMsIHNpbmNlIHdlIGFzc3VtZSB0aGUgY2xpZW50IGlzIGdvbmUuXG4gIF9kZWFjdGl2YXRlQWxsU3Vic2NyaXB0aW9uczogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcblxuICAgIHNlbGYuX25hbWVkU3Vicy5mb3JFYWNoKGZ1bmN0aW9uIChzdWIsIGlkKSB7XG4gICAgICBzdWIuX2RlYWN0aXZhdGUoKTtcbiAgICB9KTtcbiAgICBzZWxmLl9uYW1lZFN1YnMgPSBuZXcgTWFwKCk7XG5cbiAgICBzZWxmLl91bml2ZXJzYWxTdWJzLmZvckVhY2goZnVuY3Rpb24gKHN1Yikge1xuICAgICAgc3ViLl9kZWFjdGl2YXRlKCk7XG4gICAgfSk7XG4gICAgc2VsZi5fdW5pdmVyc2FsU3VicyA9IFtdO1xuICB9LFxuXG4gIC8vIERldGVybWluZSB0aGUgcmVtb3RlIGNsaWVudCdzIElQIGFkZHJlc3MsIGJhc2VkIG9uIHRoZVxuICAvLyBIVFRQX0ZPUldBUkRFRF9DT1VOVCBlbnZpcm9ubWVudCB2YXJpYWJsZSByZXByZXNlbnRpbmcgaG93IG1hbnlcbiAgLy8gcHJveGllcyB0aGUgc2VydmVyIGlzIGJlaGluZC5cbiAgX2NsaWVudEFkZHJlc3M6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgICAvLyBGb3IgdGhlIHJlcG9ydGVkIGNsaWVudCBhZGRyZXNzIGZvciBhIGNvbm5lY3Rpb24gdG8gYmUgY29ycmVjdCxcbiAgICAvLyB0aGUgZGV2ZWxvcGVyIG11c3Qgc2V0IHRoZSBIVFRQX0ZPUldBUkRFRF9DT1VOVCBlbnZpcm9ubWVudFxuICAgIC8vIHZhcmlhYmxlIHRvIGFuIGludGVnZXIgcmVwcmVzZW50aW5nIHRoZSBudW1iZXIgb2YgaG9wcyB0aGV5XG4gICAgLy8gZXhwZWN0IGluIHRoZSBgeC1mb3J3YXJkZWQtZm9yYCBoZWFkZXIuIEUuZy4sIHNldCB0byBcIjFcIiBpZiB0aGVcbiAgICAvLyBzZXJ2ZXIgaXMgYmVoaW5kIG9uZSBwcm94eS5cbiAgICAvL1xuICAgIC8vIFRoaXMgY291bGQgYmUgY29tcHV0ZWQgb25jZSBhdCBzdGFydHVwIGluc3RlYWQgb2YgZXZlcnkgdGltZS5cbiAgICB2YXIgaHR0cEZvcndhcmRlZENvdW50ID0gcGFyc2VJbnQocHJvY2Vzcy5lbnZbJ0hUVFBfRk9SV0FSREVEX0NPVU5UJ10pIHx8IDA7XG5cbiAgICBpZiAoaHR0cEZvcndhcmRlZENvdW50ID09PSAwKVxuICAgICAgcmV0dXJuIHNlbGYuc29ja2V0LnJlbW90ZUFkZHJlc3M7XG5cbiAgICB2YXIgZm9yd2FyZGVkRm9yID0gc2VsZi5zb2NrZXQuaGVhZGVyc1tcIngtZm9yd2FyZGVkLWZvclwiXTtcbiAgICBpZiAoISBfLmlzU3RyaW5nKGZvcndhcmRlZEZvcikpXG4gICAgICByZXR1cm4gbnVsbDtcbiAgICBmb3J3YXJkZWRGb3IgPSBmb3J3YXJkZWRGb3IudHJpbSgpLnNwbGl0KC9cXHMqLFxccyovKTtcblxuICAgIC8vIFR5cGljYWxseSB0aGUgZmlyc3QgdmFsdWUgaW4gdGhlIGB4LWZvcndhcmRlZC1mb3JgIGhlYWRlciBpc1xuICAgIC8vIHRoZSBvcmlnaW5hbCBJUCBhZGRyZXNzIG9mIHRoZSBjbGllbnQgY29ubmVjdGluZyB0byB0aGUgZmlyc3RcbiAgICAvLyBwcm94eS4gIEhvd2V2ZXIsIHRoZSBlbmQgdXNlciBjYW4gZWFzaWx5IHNwb29mIHRoZSBoZWFkZXIsIGluXG4gICAgLy8gd2hpY2ggY2FzZSB0aGUgZmlyc3QgdmFsdWUocykgd2lsbCBiZSB0aGUgZmFrZSBJUCBhZGRyZXNzIGZyb21cbiAgICAvLyB0aGUgdXNlciBwcmV0ZW5kaW5nIHRvIGJlIGEgcHJveHkgcmVwb3J0aW5nIHRoZSBvcmlnaW5hbCBJUFxuICAgIC8vIGFkZHJlc3MgdmFsdWUuICBCeSBjb3VudGluZyBIVFRQX0ZPUldBUkRFRF9DT1VOVCBiYWNrIGZyb20gdGhlXG4gICAgLy8gZW5kIG9mIHRoZSBsaXN0LCB3ZSBlbnN1cmUgdGhhdCB3ZSBnZXQgdGhlIElQIGFkZHJlc3MgYmVpbmdcbiAgICAvLyByZXBvcnRlZCBieSAqb3VyKiBmaXJzdCBwcm94eS5cblxuICAgIGlmIChodHRwRm9yd2FyZGVkQ291bnQgPCAwIHx8IGh0dHBGb3J3YXJkZWRDb3VudCA+IGZvcndhcmRlZEZvci5sZW5ndGgpXG4gICAgICByZXR1cm4gbnVsbDtcblxuICAgIHJldHVybiBmb3J3YXJkZWRGb3JbZm9yd2FyZGVkRm9yLmxlbmd0aCAtIGh0dHBGb3J3YXJkZWRDb3VudF07XG4gIH1cbn0pO1xuXG4vKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqL1xuLyogU3Vic2NyaXB0aW9uICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKi9cbi8qKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiovXG5cbi8vIEN0b3IgZm9yIGEgc3ViIGhhbmRsZTogdGhlIGlucHV0IHRvIGVhY2ggcHVibGlzaCBmdW5jdGlvblxuXG4vLyBJbnN0YW5jZSBuYW1lIGlzIHRoaXMgYmVjYXVzZSBpdCdzIHVzdWFsbHkgcmVmZXJyZWQgdG8gYXMgdGhpcyBpbnNpZGUgYVxuLy8gcHVibGlzaFxuLyoqXG4gKiBAc3VtbWFyeSBUaGUgc2VydmVyJ3Mgc2lkZSBvZiBhIHN1YnNjcmlwdGlvblxuICogQGNsYXNzIFN1YnNjcmlwdGlvblxuICogQGluc3RhbmNlTmFtZSB0aGlzXG4gKiBAc2hvd0luc3RhbmNlTmFtZSB0cnVlXG4gKi9cbnZhciBTdWJzY3JpcHRpb24gPSBmdW5jdGlvbiAoXG4gICAgc2Vzc2lvbiwgaGFuZGxlciwgc3Vic2NyaXB0aW9uSWQsIHBhcmFtcywgbmFtZSkge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIHNlbGYuX3Nlc3Npb24gPSBzZXNzaW9uOyAvLyB0eXBlIGlzIFNlc3Npb25cblxuICAvKipcbiAgICogQHN1bW1hcnkgQWNjZXNzIGluc2lkZSB0aGUgcHVibGlzaCBmdW5jdGlvbi4gVGhlIGluY29taW5nIFtjb25uZWN0aW9uXSgjbWV0ZW9yX29uY29ubmVjdGlvbikgZm9yIHRoaXMgc3Vic2NyaXB0aW9uLlxuICAgKiBAbG9jdXMgU2VydmVyXG4gICAqIEBuYW1lICBjb25uZWN0aW9uXG4gICAqIEBtZW1iZXJPZiBTdWJzY3JpcHRpb25cbiAgICogQGluc3RhbmNlXG4gICAqL1xuICBzZWxmLmNvbm5lY3Rpb24gPSBzZXNzaW9uLmNvbm5lY3Rpb25IYW5kbGU7IC8vIHB1YmxpYyBBUEkgb2JqZWN0XG5cbiAgc2VsZi5faGFuZGxlciA9IGhhbmRsZXI7XG5cbiAgLy8gTXkgc3Vic2NyaXB0aW9uIElEIChnZW5lcmF0ZWQgYnkgY2xpZW50LCB1bmRlZmluZWQgZm9yIHVuaXZlcnNhbCBzdWJzKS5cbiAgc2VsZi5fc3Vic2NyaXB0aW9uSWQgPSBzdWJzY3JpcHRpb25JZDtcbiAgLy8gVW5kZWZpbmVkIGZvciB1bml2ZXJzYWwgc3Vic1xuICBzZWxmLl9uYW1lID0gbmFtZTtcblxuICBzZWxmLl9wYXJhbXMgPSBwYXJhbXMgfHwgW107XG5cbiAgLy8gT25seSBuYW1lZCBzdWJzY3JpcHRpb25zIGhhdmUgSURzLCBidXQgd2UgbmVlZCBzb21lIHNvcnQgb2Ygc3RyaW5nXG4gIC8vIGludGVybmFsbHkgdG8ga2VlcCB0cmFjayBvZiBhbGwgc3Vic2NyaXB0aW9ucyBpbnNpZGVcbiAgLy8gU2Vzc2lvbkRvY3VtZW50Vmlld3MuIFdlIHVzZSB0aGlzIHN1YnNjcmlwdGlvbkhhbmRsZSBmb3IgdGhhdC5cbiAgaWYgKHNlbGYuX3N1YnNjcmlwdGlvbklkKSB7XG4gICAgc2VsZi5fc3Vic2NyaXB0aW9uSGFuZGxlID0gJ04nICsgc2VsZi5fc3Vic2NyaXB0aW9uSWQ7XG4gIH0gZWxzZSB7XG4gICAgc2VsZi5fc3Vic2NyaXB0aW9uSGFuZGxlID0gJ1UnICsgUmFuZG9tLmlkKCk7XG4gIH1cblxuICAvLyBIYXMgX2RlYWN0aXZhdGUgYmVlbiBjYWxsZWQ/XG4gIHNlbGYuX2RlYWN0aXZhdGVkID0gZmFsc2U7XG5cbiAgLy8gU3RvcCBjYWxsYmFja3MgdG8gZy9jIHRoaXMgc3ViLiAgY2FsbGVkIHcvIHplcm8gYXJndW1lbnRzLlxuICBzZWxmLl9zdG9wQ2FsbGJhY2tzID0gW107XG5cbiAgLy8gVGhlIHNldCBvZiAoY29sbGVjdGlvbiwgZG9jdW1lbnRpZCkgdGhhdCB0aGlzIHN1YnNjcmlwdGlvbiBoYXNcbiAgLy8gYW4gb3BpbmlvbiBhYm91dC5cbiAgc2VsZi5fZG9jdW1lbnRzID0gbmV3IE1hcCgpO1xuXG4gIC8vIFJlbWVtYmVyIGlmIHdlIGFyZSByZWFkeS5cbiAgc2VsZi5fcmVhZHkgPSBmYWxzZTtcblxuICAvLyBQYXJ0IG9mIHRoZSBwdWJsaWMgQVBJOiB0aGUgdXNlciBvZiB0aGlzIHN1Yi5cblxuICAvKipcbiAgICogQHN1bW1hcnkgQWNjZXNzIGluc2lkZSB0aGUgcHVibGlzaCBmdW5jdGlvbi4gVGhlIGlkIG9mIHRoZSBsb2dnZWQtaW4gdXNlciwgb3IgYG51bGxgIGlmIG5vIHVzZXIgaXMgbG9nZ2VkIGluLlxuICAgKiBAbG9jdXMgU2VydmVyXG4gICAqIEBtZW1iZXJPZiBTdWJzY3JpcHRpb25cbiAgICogQG5hbWUgIHVzZXJJZFxuICAgKiBAaW5zdGFuY2VcbiAgICovXG4gIHNlbGYudXNlcklkID0gc2Vzc2lvbi51c2VySWQ7XG5cbiAgLy8gRm9yIG5vdywgdGhlIGlkIGZpbHRlciBpcyBnb2luZyB0byBkZWZhdWx0IHRvXG4gIC8vIHRoZSB0by9mcm9tIEREUCBtZXRob2RzIG9uIE1vbmdvSUQsIHRvXG4gIC8vIHNwZWNpZmljYWxseSBkZWFsIHdpdGggbW9uZ28vbWluaW1vbmdvIE9iamVjdElkcy5cblxuICAvLyBMYXRlciwgeW91IHdpbGwgYmUgYWJsZSB0byBtYWtlIHRoaXMgYmUgXCJyYXdcIlxuICAvLyBpZiB5b3Ugd2FudCB0byBwdWJsaXNoIGEgY29sbGVjdGlvbiB0aGF0IHlvdSBrbm93XG4gIC8vIGp1c3QgaGFzIHN0cmluZ3MgZm9yIGtleXMgYW5kIG5vIGZ1bm55IGJ1c2luZXNzLCB0b1xuICAvLyBhIEREUCBjb25zdW1lciB0aGF0IGlzbid0IG1pbmltb25nby5cblxuICBzZWxmLl9pZEZpbHRlciA9IHtcbiAgICBpZFN0cmluZ2lmeTogTW9uZ29JRC5pZFN0cmluZ2lmeSxcbiAgICBpZFBhcnNlOiBNb25nb0lELmlkUGFyc2VcbiAgfTtcblxuICBQYWNrYWdlWydmYWN0cy1iYXNlJ10gJiYgUGFja2FnZVsnZmFjdHMtYmFzZSddLkZhY3RzLmluY3JlbWVudFNlcnZlckZhY3QoXG4gICAgXCJsaXZlZGF0YVwiLCBcInN1YnNjcmlwdGlvbnNcIiwgMSk7XG59O1xuXG5PYmplY3QuYXNzaWduKFN1YnNjcmlwdGlvbi5wcm90b3R5cGUsIHtcbiAgX3J1bkhhbmRsZXI6IGZ1bmN0aW9uKCkge1xuICAgIC8vIFhYWCBzaG91bGQgd2UgdW5ibG9jaygpIGhlcmU/IEVpdGhlciBiZWZvcmUgcnVubmluZyB0aGUgcHVibGlzaFxuICAgIC8vIGZ1bmN0aW9uLCBvciBiZWZvcmUgcnVubmluZyBfcHVibGlzaEN1cnNvci5cbiAgICAvL1xuICAgIC8vIFJpZ2h0IG5vdywgZWFjaCBwdWJsaXNoIGZ1bmN0aW9uIGJsb2NrcyBhbGwgZnV0dXJlIHB1Ymxpc2hlcyBhbmRcbiAgICAvLyBtZXRob2RzIHdhaXRpbmcgb24gZGF0YSBmcm9tIE1vbmdvIChvciB3aGF0ZXZlciBlbHNlIHRoZSBmdW5jdGlvblxuICAgIC8vIGJsb2NrcyBvbikuIFRoaXMgcHJvYmFibHkgc2xvd3MgcGFnZSBsb2FkIGluIGNvbW1vbiBjYXNlcy5cblxuICAgIGlmICghdGhpcy51bmJsb2NrKSB7XG4gICAgICB0aGlzLnVuYmxvY2sgPSAoKSA9PiB7fTtcbiAgICB9XG5cbiAgICBjb25zdCBzZWxmID0gdGhpcztcbiAgICBsZXQgcmVzdWx0T3JUaGVuYWJsZSA9IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgIHJlc3VsdE9yVGhlbmFibGUgPSBERFAuX0N1cnJlbnRQdWJsaWNhdGlvbkludm9jYXRpb24ud2l0aFZhbHVlKHNlbGYsICgpID0+XG4gICAgICAgIG1heWJlQXVkaXRBcmd1bWVudENoZWNrcyhcbiAgICAgICAgICBzZWxmLl9oYW5kbGVyLFxuICAgICAgICAgIHNlbGYsXG4gICAgICAgICAgRUpTT04uY2xvbmUoc2VsZi5fcGFyYW1zKSxcbiAgICAgICAgICAvLyBJdCdzIE9LIHRoYXQgdGhpcyB3b3VsZCBsb29rIHdlaXJkIGZvciB1bml2ZXJzYWwgc3Vic2NyaXB0aW9ucyxcbiAgICAgICAgICAvLyBiZWNhdXNlIHRoZXkgaGF2ZSBubyBhcmd1bWVudHMgc28gdGhlcmUgY2FuIG5ldmVyIGJlIGFuXG4gICAgICAgICAgLy8gYXVkaXQtYXJndW1lbnQtY2hlY2tzIGZhaWx1cmUuXG4gICAgICAgICAgXCJwdWJsaXNoZXIgJ1wiICsgc2VsZi5fbmFtZSArIFwiJ1wiXG4gICAgICAgIClcbiAgICAgICk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgc2VsZi5lcnJvcihlKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBEaWQgdGhlIGhhbmRsZXIgY2FsbCB0aGlzLmVycm9yIG9yIHRoaXMuc3RvcD9cbiAgICBpZiAoc2VsZi5faXNEZWFjdGl2YXRlZCgpKSByZXR1cm47XG5cbiAgICAvLyBCb3RoIGNvbnZlbnRpb25hbCBhbmQgYXN5bmMgcHVibGlzaCBoYW5kbGVyIGZ1bmN0aW9ucyBhcmUgc3VwcG9ydGVkLlxuICAgIC8vIElmIGFuIG9iamVjdCBpcyByZXR1cm5lZCB3aXRoIGEgdGhlbigpIGZ1bmN0aW9uLCBpdCBpcyBlaXRoZXIgYSBwcm9taXNlXG4gICAgLy8gb3IgdGhlbmFibGUgYW5kIHdpbGwgYmUgcmVzb2x2ZWQgYXN5bmNocm9ub3VzbHkuXG4gICAgY29uc3QgaXNUaGVuYWJsZSA9XG4gICAgICByZXN1bHRPclRoZW5hYmxlICYmIHR5cGVvZiByZXN1bHRPclRoZW5hYmxlLnRoZW4gPT09ICdmdW5jdGlvbic7XG4gICAgaWYgKGlzVGhlbmFibGUpIHtcbiAgICAgIFByb21pc2UucmVzb2x2ZShyZXN1bHRPclRoZW5hYmxlKS50aGVuKFxuICAgICAgICAoLi4uYXJncykgPT4gc2VsZi5fcHVibGlzaEhhbmRsZXJSZXN1bHQuYmluZChzZWxmKSguLi5hcmdzKSxcbiAgICAgICAgZSA9PiBzZWxmLmVycm9yKGUpXG4gICAgICApO1xuICAgIH0gZWxzZSB7XG4gICAgICBzZWxmLl9wdWJsaXNoSGFuZGxlclJlc3VsdChyZXN1bHRPclRoZW5hYmxlKTtcbiAgICB9XG4gIH0sXG5cbiAgX3B1Ymxpc2hIYW5kbGVyUmVzdWx0OiBmdW5jdGlvbiAocmVzKSB7XG4gICAgLy8gU1BFQ0lBTCBDQVNFOiBJbnN0ZWFkIG9mIHdyaXRpbmcgdGhlaXIgb3duIGNhbGxiYWNrcyB0aGF0IGludm9rZVxuICAgIC8vIHRoaXMuYWRkZWQvY2hhbmdlZC9yZWFkeS9ldGMsIHRoZSB1c2VyIGNhbiBqdXN0IHJldHVybiBhIGNvbGxlY3Rpb25cbiAgICAvLyBjdXJzb3Igb3IgYXJyYXkgb2YgY3Vyc29ycyBmcm9tIHRoZSBwdWJsaXNoIGZ1bmN0aW9uOyB3ZSBjYWxsIHRoZWlyXG4gICAgLy8gX3B1Ymxpc2hDdXJzb3IgbWV0aG9kIHdoaWNoIHN0YXJ0cyBvYnNlcnZpbmcgdGhlIGN1cnNvciBhbmQgcHVibGlzaGVzIHRoZVxuICAgIC8vIHJlc3VsdHMuIE5vdGUgdGhhdCBfcHVibGlzaEN1cnNvciBkb2VzIE5PVCBjYWxsIHJlYWR5KCkuXG4gICAgLy9cbiAgICAvLyBYWFggVGhpcyB1c2VzIGFuIHVuZG9jdW1lbnRlZCBpbnRlcmZhY2Ugd2hpY2ggb25seSB0aGUgTW9uZ28gY3Vyc29yXG4gICAgLy8gaW50ZXJmYWNlIHB1Ymxpc2hlcy4gU2hvdWxkIHdlIG1ha2UgdGhpcyBpbnRlcmZhY2UgcHVibGljIGFuZCBlbmNvdXJhZ2VcbiAgICAvLyB1c2VycyB0byBpbXBsZW1lbnQgaXQgdGhlbXNlbHZlcz8gQXJndWFibHksIGl0J3MgdW5uZWNlc3Nhcnk7IHVzZXJzIGNhblxuICAgIC8vIGFscmVhZHkgd3JpdGUgdGhlaXIgb3duIGZ1bmN0aW9ucyBsaWtlXG4gICAgLy8gICB2YXIgcHVibGlzaE15UmVhY3RpdmVUaGluZ3kgPSBmdW5jdGlvbiAobmFtZSwgaGFuZGxlcikge1xuICAgIC8vICAgICBNZXRlb3IucHVibGlzaChuYW1lLCBmdW5jdGlvbiAoKSB7XG4gICAgLy8gICAgICAgdmFyIHJlYWN0aXZlVGhpbmd5ID0gaGFuZGxlcigpO1xuICAgIC8vICAgICAgIHJlYWN0aXZlVGhpbmd5LnB1Ymxpc2hNZSgpO1xuICAgIC8vICAgICB9KTtcbiAgICAvLyAgIH07XG5cbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgdmFyIGlzQ3Vyc29yID0gZnVuY3Rpb24gKGMpIHtcbiAgICAgIHJldHVybiBjICYmIGMuX3B1Ymxpc2hDdXJzb3I7XG4gICAgfTtcbiAgICBpZiAoaXNDdXJzb3IocmVzKSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVzLl9wdWJsaXNoQ3Vyc29yKHNlbGYpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBzZWxmLmVycm9yKGUpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICAvLyBfcHVibGlzaEN1cnNvciBvbmx5IHJldHVybnMgYWZ0ZXIgdGhlIGluaXRpYWwgYWRkZWQgY2FsbGJhY2tzIGhhdmUgcnVuLlxuICAgICAgLy8gbWFyayBzdWJzY3JpcHRpb24gYXMgcmVhZHkuXG4gICAgICBzZWxmLnJlYWR5KCk7XG4gICAgfSBlbHNlIGlmIChfLmlzQXJyYXkocmVzKSkge1xuICAgICAgLy8gQ2hlY2sgYWxsIHRoZSBlbGVtZW50cyBhcmUgY3Vyc29yc1xuICAgICAgaWYgKCEgXy5hbGwocmVzLCBpc0N1cnNvcikpIHtcbiAgICAgICAgc2VsZi5lcnJvcihuZXcgRXJyb3IoXCJQdWJsaXNoIGZ1bmN0aW9uIHJldHVybmVkIGFuIGFycmF5IG9mIG5vbi1DdXJzb3JzXCIpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgLy8gRmluZCBkdXBsaWNhdGUgY29sbGVjdGlvbiBuYW1lc1xuICAgICAgLy8gWFhYIHdlIHNob3VsZCBzdXBwb3J0IG92ZXJsYXBwaW5nIGN1cnNvcnMsIGJ1dCB0aGF0IHdvdWxkIHJlcXVpcmUgdGhlXG4gICAgICAvLyBtZXJnZSBib3ggdG8gYWxsb3cgb3ZlcmxhcCB3aXRoaW4gYSBzdWJzY3JpcHRpb25cbiAgICAgIHZhciBjb2xsZWN0aW9uTmFtZXMgPSB7fTtcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgcmVzLmxlbmd0aDsgKytpKSB7XG4gICAgICAgIHZhciBjb2xsZWN0aW9uTmFtZSA9IHJlc1tpXS5fZ2V0Q29sbGVjdGlvbk5hbWUoKTtcbiAgICAgICAgaWYgKF8uaGFzKGNvbGxlY3Rpb25OYW1lcywgY29sbGVjdGlvbk5hbWUpKSB7XG4gICAgICAgICAgc2VsZi5lcnJvcihuZXcgRXJyb3IoXG4gICAgICAgICAgICBcIlB1Ymxpc2ggZnVuY3Rpb24gcmV0dXJuZWQgbXVsdGlwbGUgY3Vyc29ycyBmb3IgY29sbGVjdGlvbiBcIiArXG4gICAgICAgICAgICAgIGNvbGxlY3Rpb25OYW1lKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNvbGxlY3Rpb25OYW1lc1tjb2xsZWN0aW9uTmFtZV0gPSB0cnVlO1xuICAgICAgfTtcblxuICAgICAgdHJ5IHtcbiAgICAgICAgXy5lYWNoKHJlcywgZnVuY3Rpb24gKGN1cikge1xuICAgICAgICAgIGN1ci5fcHVibGlzaEN1cnNvcihzZWxmKTtcbiAgICAgICAgfSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHNlbGYuZXJyb3IoZSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHNlbGYucmVhZHkoKTtcbiAgICB9IGVsc2UgaWYgKHJlcykge1xuICAgICAgLy8gVHJ1dGh5IHZhbHVlcyBvdGhlciB0aGFuIGN1cnNvcnMgb3IgYXJyYXlzIGFyZSBwcm9iYWJseSBhXG4gICAgICAvLyB1c2VyIG1pc3Rha2UgKHBvc3NpYmxlIHJldHVybmluZyBhIE1vbmdvIGRvY3VtZW50IHZpYSwgc2F5LFxuICAgICAgLy8gYGNvbGwuZmluZE9uZSgpYCkuXG4gICAgICBzZWxmLmVycm9yKG5ldyBFcnJvcihcIlB1Ymxpc2ggZnVuY3Rpb24gY2FuIG9ubHkgcmV0dXJuIGEgQ3Vyc29yIG9yIFwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICArIFwiYW4gYXJyYXkgb2YgQ3Vyc29yc1wiKSk7XG4gICAgfVxuICB9LFxuXG4gIC8vIFRoaXMgY2FsbHMgYWxsIHN0b3AgY2FsbGJhY2tzIGFuZCBwcmV2ZW50cyB0aGUgaGFuZGxlciBmcm9tIHVwZGF0aW5nIGFueVxuICAvLyBTZXNzaW9uQ29sbGVjdGlvblZpZXdzIGZ1cnRoZXIuIEl0J3MgdXNlZCB3aGVuIHRoZSB1c2VyIHVuc3Vic2NyaWJlcyBvclxuICAvLyBkaXNjb25uZWN0cywgYXMgd2VsbCBhcyBkdXJpbmcgc2V0VXNlcklkIHJlLXJ1bnMuIEl0IGRvZXMgKk5PVCogc2VuZFxuICAvLyByZW1vdmVkIG1lc3NhZ2VzIGZvciB0aGUgcHVibGlzaGVkIG9iamVjdHM7IGlmIHRoYXQgaXMgbmVjZXNzYXJ5LCBjYWxsXG4gIC8vIF9yZW1vdmVBbGxEb2N1bWVudHMgZmlyc3QuXG4gIF9kZWFjdGl2YXRlOiBmdW5jdGlvbigpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKHNlbGYuX2RlYWN0aXZhdGVkKVxuICAgICAgcmV0dXJuO1xuICAgIHNlbGYuX2RlYWN0aXZhdGVkID0gdHJ1ZTtcbiAgICBzZWxmLl9jYWxsU3RvcENhbGxiYWNrcygpO1xuICAgIFBhY2thZ2VbJ2ZhY3RzLWJhc2UnXSAmJiBQYWNrYWdlWydmYWN0cy1iYXNlJ10uRmFjdHMuaW5jcmVtZW50U2VydmVyRmFjdChcbiAgICAgIFwibGl2ZWRhdGFcIiwgXCJzdWJzY3JpcHRpb25zXCIsIC0xKTtcbiAgfSxcblxuICBfY2FsbFN0b3BDYWxsYmFja3M6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgLy8gVGVsbCBsaXN0ZW5lcnMsIHNvIHRoZXkgY2FuIGNsZWFuIHVwXG4gICAgdmFyIGNhbGxiYWNrcyA9IHNlbGYuX3N0b3BDYWxsYmFja3M7XG4gICAgc2VsZi5fc3RvcENhbGxiYWNrcyA9IFtdO1xuICAgIF8uZWFjaChjYWxsYmFja3MsIGZ1bmN0aW9uIChjYWxsYmFjaykge1xuICAgICAgY2FsbGJhY2soKTtcbiAgICB9KTtcbiAgfSxcblxuICAvLyBTZW5kIHJlbW92ZSBtZXNzYWdlcyBmb3IgZXZlcnkgZG9jdW1lbnQuXG4gIF9yZW1vdmVBbGxEb2N1bWVudHM6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgTWV0ZW9yLl9ub1lpZWxkc0FsbG93ZWQoZnVuY3Rpb24gKCkge1xuICAgICAgc2VsZi5fZG9jdW1lbnRzLmZvckVhY2goZnVuY3Rpb24gKGNvbGxlY3Rpb25Eb2NzLCBjb2xsZWN0aW9uTmFtZSkge1xuICAgICAgICBjb2xsZWN0aW9uRG9jcy5mb3JFYWNoKGZ1bmN0aW9uIChzdHJJZCkge1xuICAgICAgICAgIHNlbGYucmVtb3ZlZChjb2xsZWN0aW9uTmFtZSwgc2VsZi5faWRGaWx0ZXIuaWRQYXJzZShzdHJJZCkpO1xuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9LFxuXG4gIC8vIFJldHVybnMgYSBuZXcgU3Vic2NyaXB0aW9uIGZvciB0aGUgc2FtZSBzZXNzaW9uIHdpdGggdGhlIHNhbWVcbiAgLy8gaW5pdGlhbCBjcmVhdGlvbiBwYXJhbWV0ZXJzLiBUaGlzIGlzbid0IGEgY2xvbmU6IGl0IGRvZXNuJ3QgaGF2ZVxuICAvLyB0aGUgc2FtZSBfZG9jdW1lbnRzIGNhY2hlLCBzdG9wcGVkIHN0YXRlIG9yIGNhbGxiYWNrczsgbWF5IGhhdmUgYVxuICAvLyBkaWZmZXJlbnQgX3N1YnNjcmlwdGlvbkhhbmRsZSwgYW5kIGdldHMgaXRzIHVzZXJJZCBmcm9tIHRoZVxuICAvLyBzZXNzaW9uLCBub3QgZnJvbSB0aGlzIG9iamVjdC5cbiAgX3JlY3JlYXRlOiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHJldHVybiBuZXcgU3Vic2NyaXB0aW9uKFxuICAgICAgc2VsZi5fc2Vzc2lvbiwgc2VsZi5faGFuZGxlciwgc2VsZi5fc3Vic2NyaXB0aW9uSWQsIHNlbGYuX3BhcmFtcyxcbiAgICAgIHNlbGYuX25hbWUpO1xuICB9LFxuXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBDYWxsIGluc2lkZSB0aGUgcHVibGlzaCBmdW5jdGlvbi4gIFN0b3BzIHRoaXMgY2xpZW50J3Mgc3Vic2NyaXB0aW9uLCB0cmlnZ2VyaW5nIGEgY2FsbCBvbiB0aGUgY2xpZW50IHRvIHRoZSBgb25TdG9wYCBjYWxsYmFjayBwYXNzZWQgdG8gW2BNZXRlb3Iuc3Vic2NyaWJlYF0oI21ldGVvcl9zdWJzY3JpYmUpLCBpZiBhbnkuIElmIGBlcnJvcmAgaXMgbm90IGEgW2BNZXRlb3IuRXJyb3JgXSgjbWV0ZW9yX2Vycm9yKSwgaXQgd2lsbCBiZSBbc2FuaXRpemVkXSgjbWV0ZW9yX2Vycm9yKS5cbiAgICogQGxvY3VzIFNlcnZlclxuICAgKiBAcGFyYW0ge0Vycm9yfSBlcnJvciBUaGUgZXJyb3IgdG8gcGFzcyB0byB0aGUgY2xpZW50LlxuICAgKiBAaW5zdGFuY2VcbiAgICogQG1lbWJlck9mIFN1YnNjcmlwdGlvblxuICAgKi9cbiAgZXJyb3I6IGZ1bmN0aW9uIChlcnJvcikge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoc2VsZi5faXNEZWFjdGl2YXRlZCgpKVxuICAgICAgcmV0dXJuO1xuICAgIHNlbGYuX3Nlc3Npb24uX3N0b3BTdWJzY3JpcHRpb24oc2VsZi5fc3Vic2NyaXB0aW9uSWQsIGVycm9yKTtcbiAgfSxcblxuICAvLyBOb3RlIHRoYXQgd2hpbGUgb3VyIEREUCBjbGllbnQgd2lsbCBub3RpY2UgdGhhdCB5b3UndmUgY2FsbGVkIHN0b3AoKSBvbiB0aGVcbiAgLy8gc2VydmVyIChhbmQgY2xlYW4gdXAgaXRzIF9zdWJzY3JpcHRpb25zIHRhYmxlKSB3ZSBkb24ndCBhY3R1YWxseSBwcm92aWRlIGFcbiAgLy8gbWVjaGFuaXNtIGZvciBhbiBhcHAgdG8gbm90aWNlIHRoaXMgKHRoZSBzdWJzY3JpYmUgb25FcnJvciBjYWxsYmFjayBvbmx5XG4gIC8vIHRyaWdnZXJzIGlmIHRoZXJlIGlzIGFuIGVycm9yKS5cblxuICAvKipcbiAgICogQHN1bW1hcnkgQ2FsbCBpbnNpZGUgdGhlIHB1Ymxpc2ggZnVuY3Rpb24uICBTdG9wcyB0aGlzIGNsaWVudCdzIHN1YnNjcmlwdGlvbiBhbmQgaW52b2tlcyB0aGUgY2xpZW50J3MgYG9uU3RvcGAgY2FsbGJhY2sgd2l0aCBubyBlcnJvci5cbiAgICogQGxvY3VzIFNlcnZlclxuICAgKiBAaW5zdGFuY2VcbiAgICogQG1lbWJlck9mIFN1YnNjcmlwdGlvblxuICAgKi9cbiAgc3RvcDogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoc2VsZi5faXNEZWFjdGl2YXRlZCgpKVxuICAgICAgcmV0dXJuO1xuICAgIHNlbGYuX3Nlc3Npb24uX3N0b3BTdWJzY3JpcHRpb24oc2VsZi5fc3Vic2NyaXB0aW9uSWQpO1xuICB9LFxuXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBDYWxsIGluc2lkZSB0aGUgcHVibGlzaCBmdW5jdGlvbi4gIFJlZ2lzdGVycyBhIGNhbGxiYWNrIGZ1bmN0aW9uIHRvIHJ1biB3aGVuIHRoZSBzdWJzY3JpcHRpb24gaXMgc3RvcHBlZC5cbiAgICogQGxvY3VzIFNlcnZlclxuICAgKiBAbWVtYmVyT2YgU3Vic2NyaXB0aW9uXG4gICAqIEBpbnN0YW5jZVxuICAgKiBAcGFyYW0ge0Z1bmN0aW9ufSBmdW5jIFRoZSBjYWxsYmFjayBmdW5jdGlvblxuICAgKi9cbiAgb25TdG9wOiBmdW5jdGlvbiAoY2FsbGJhY2spIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgY2FsbGJhY2sgPSBNZXRlb3IuYmluZEVudmlyb25tZW50KGNhbGxiYWNrLCAnb25TdG9wIGNhbGxiYWNrJywgc2VsZik7XG4gICAgaWYgKHNlbGYuX2lzRGVhY3RpdmF0ZWQoKSlcbiAgICAgIGNhbGxiYWNrKCk7XG4gICAgZWxzZVxuICAgICAgc2VsZi5fc3RvcENhbGxiYWNrcy5wdXNoKGNhbGxiYWNrKTtcbiAgfSxcblxuICAvLyBUaGlzIHJldHVybnMgdHJ1ZSBpZiB0aGUgc3ViIGhhcyBiZWVuIGRlYWN0aXZhdGVkLCAqT1IqIGlmIHRoZSBzZXNzaW9uIHdhc1xuICAvLyBkZXN0cm95ZWQgYnV0IHRoZSBkZWZlcnJlZCBjYWxsIHRvIF9kZWFjdGl2YXRlQWxsU3Vic2NyaXB0aW9ucyBoYXNuJ3RcbiAgLy8gaGFwcGVuZWQgeWV0LlxuICBfaXNEZWFjdGl2YXRlZDogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICByZXR1cm4gc2VsZi5fZGVhY3RpdmF0ZWQgfHwgc2VsZi5fc2Vzc2lvbi5pblF1ZXVlID09PSBudWxsO1xuICB9LFxuXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBDYWxsIGluc2lkZSB0aGUgcHVibGlzaCBmdW5jdGlvbi4gIEluZm9ybXMgdGhlIHN1YnNjcmliZXIgdGhhdCBhIGRvY3VtZW50IGhhcyBiZWVuIGFkZGVkIHRvIHRoZSByZWNvcmQgc2V0LlxuICAgKiBAbG9jdXMgU2VydmVyXG4gICAqIEBtZW1iZXJPZiBTdWJzY3JpcHRpb25cbiAgICogQGluc3RhbmNlXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBjb2xsZWN0aW9uIFRoZSBuYW1lIG9mIHRoZSBjb2xsZWN0aW9uIHRoYXQgY29udGFpbnMgdGhlIG5ldyBkb2N1bWVudC5cbiAgICogQHBhcmFtIHtTdHJpbmd9IGlkIFRoZSBuZXcgZG9jdW1lbnQncyBJRC5cbiAgICogQHBhcmFtIHtPYmplY3R9IGZpZWxkcyBUaGUgZmllbGRzIGluIHRoZSBuZXcgZG9jdW1lbnQuICBJZiBgX2lkYCBpcyBwcmVzZW50IGl0IGlzIGlnbm9yZWQuXG4gICAqL1xuICBhZGRlZCAoY29sbGVjdGlvbk5hbWUsIGlkLCBmaWVsZHMpIHtcbiAgICBpZiAodGhpcy5faXNEZWFjdGl2YXRlZCgpKVxuICAgICAgcmV0dXJuO1xuICAgIGlkID0gdGhpcy5faWRGaWx0ZXIuaWRTdHJpbmdpZnkoaWQpO1xuXG4gICAgaWYgKHRoaXMuX3Nlc3Npb24uc2VydmVyLmdldFB1YmxpY2F0aW9uU3RyYXRlZ3koY29sbGVjdGlvbk5hbWUpLmRvQWNjb3VudGluZ0ZvckNvbGxlY3Rpb24pIHtcbiAgICAgIGxldCBpZHMgPSB0aGlzLl9kb2N1bWVudHMuZ2V0KGNvbGxlY3Rpb25OYW1lKTtcbiAgICAgIGlmIChpZHMgPT0gbnVsbCkge1xuICAgICAgICBpZHMgPSBuZXcgU2V0KCk7XG4gICAgICAgIHRoaXMuX2RvY3VtZW50cy5zZXQoY29sbGVjdGlvbk5hbWUsIGlkcyk7XG4gICAgICB9XG4gICAgICBpZHMuYWRkKGlkKTtcbiAgICB9XG5cbiAgICB0aGlzLl9zZXNzaW9uLmFkZGVkKHRoaXMuX3N1YnNjcmlwdGlvbkhhbmRsZSwgY29sbGVjdGlvbk5hbWUsIGlkLCBmaWVsZHMpO1xuICB9LFxuXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBDYWxsIGluc2lkZSB0aGUgcHVibGlzaCBmdW5jdGlvbi4gIEluZm9ybXMgdGhlIHN1YnNjcmliZXIgdGhhdCBhIGRvY3VtZW50IGluIHRoZSByZWNvcmQgc2V0IGhhcyBiZWVuIG1vZGlmaWVkLlxuICAgKiBAbG9jdXMgU2VydmVyXG4gICAqIEBtZW1iZXJPZiBTdWJzY3JpcHRpb25cbiAgICogQGluc3RhbmNlXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBjb2xsZWN0aW9uIFRoZSBuYW1lIG9mIHRoZSBjb2xsZWN0aW9uIHRoYXQgY29udGFpbnMgdGhlIGNoYW5nZWQgZG9jdW1lbnQuXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBpZCBUaGUgY2hhbmdlZCBkb2N1bWVudCdzIElELlxuICAgKiBAcGFyYW0ge09iamVjdH0gZmllbGRzIFRoZSBmaWVsZHMgaW4gdGhlIGRvY3VtZW50IHRoYXQgaGF2ZSBjaGFuZ2VkLCB0b2dldGhlciB3aXRoIHRoZWlyIG5ldyB2YWx1ZXMuICBJZiBhIGZpZWxkIGlzIG5vdCBwcmVzZW50IGluIGBmaWVsZHNgIGl0IHdhcyBsZWZ0IHVuY2hhbmdlZDsgaWYgaXQgaXMgcHJlc2VudCBpbiBgZmllbGRzYCBhbmQgaGFzIGEgdmFsdWUgb2YgYHVuZGVmaW5lZGAgaXQgd2FzIHJlbW92ZWQgZnJvbSB0aGUgZG9jdW1lbnQuICBJZiBgX2lkYCBpcyBwcmVzZW50IGl0IGlzIGlnbm9yZWQuXG4gICAqL1xuICBjaGFuZ2VkIChjb2xsZWN0aW9uTmFtZSwgaWQsIGZpZWxkcykge1xuICAgIGlmICh0aGlzLl9pc0RlYWN0aXZhdGVkKCkpXG4gICAgICByZXR1cm47XG4gICAgaWQgPSB0aGlzLl9pZEZpbHRlci5pZFN0cmluZ2lmeShpZCk7XG4gICAgdGhpcy5fc2Vzc2lvbi5jaGFuZ2VkKHRoaXMuX3N1YnNjcmlwdGlvbkhhbmRsZSwgY29sbGVjdGlvbk5hbWUsIGlkLCBmaWVsZHMpO1xuICB9LFxuXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBDYWxsIGluc2lkZSB0aGUgcHVibGlzaCBmdW5jdGlvbi4gIEluZm9ybXMgdGhlIHN1YnNjcmliZXIgdGhhdCBhIGRvY3VtZW50IGhhcyBiZWVuIHJlbW92ZWQgZnJvbSB0aGUgcmVjb3JkIHNldC5cbiAgICogQGxvY3VzIFNlcnZlclxuICAgKiBAbWVtYmVyT2YgU3Vic2NyaXB0aW9uXG4gICAqIEBpbnN0YW5jZVxuICAgKiBAcGFyYW0ge1N0cmluZ30gY29sbGVjdGlvbiBUaGUgbmFtZSBvZiB0aGUgY29sbGVjdGlvbiB0aGF0IHRoZSBkb2N1bWVudCBoYXMgYmVlbiByZW1vdmVkIGZyb20uXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBpZCBUaGUgSUQgb2YgdGhlIGRvY3VtZW50IHRoYXQgaGFzIGJlZW4gcmVtb3ZlZC5cbiAgICovXG4gIHJlbW92ZWQgKGNvbGxlY3Rpb25OYW1lLCBpZCkge1xuICAgIGlmICh0aGlzLl9pc0RlYWN0aXZhdGVkKCkpXG4gICAgICByZXR1cm47XG4gICAgaWQgPSB0aGlzLl9pZEZpbHRlci5pZFN0cmluZ2lmeShpZCk7XG5cbiAgICBpZiAodGhpcy5fc2Vzc2lvbi5zZXJ2ZXIuZ2V0UHVibGljYXRpb25TdHJhdGVneShjb2xsZWN0aW9uTmFtZSkuZG9BY2NvdW50aW5nRm9yQ29sbGVjdGlvbikge1xuICAgICAgLy8gV2UgZG9uJ3QgYm90aGVyIHRvIGRlbGV0ZSBzZXRzIG9mIHRoaW5ncyBpbiBhIGNvbGxlY3Rpb24gaWYgdGhlXG4gICAgICAvLyBjb2xsZWN0aW9uIGlzIGVtcHR5LiAgSXQgY291bGQgYnJlYWsgX3JlbW92ZUFsbERvY3VtZW50cy5cbiAgICAgIHRoaXMuX2RvY3VtZW50cy5nZXQoY29sbGVjdGlvbk5hbWUpLmRlbGV0ZShpZCk7XG4gICAgfVxuXG4gICAgdGhpcy5fc2Vzc2lvbi5yZW1vdmVkKHRoaXMuX3N1YnNjcmlwdGlvbkhhbmRsZSwgY29sbGVjdGlvbk5hbWUsIGlkKTtcbiAgfSxcblxuICAvKipcbiAgICogQHN1bW1hcnkgQ2FsbCBpbnNpZGUgdGhlIHB1Ymxpc2ggZnVuY3Rpb24uICBJbmZvcm1zIHRoZSBzdWJzY3JpYmVyIHRoYXQgYW4gaW5pdGlhbCwgY29tcGxldGUgc25hcHNob3Qgb2YgdGhlIHJlY29yZCBzZXQgaGFzIGJlZW4gc2VudC4gIFRoaXMgd2lsbCB0cmlnZ2VyIGEgY2FsbCBvbiB0aGUgY2xpZW50IHRvIHRoZSBgb25SZWFkeWAgY2FsbGJhY2sgcGFzc2VkIHRvICBbYE1ldGVvci5zdWJzY3JpYmVgXSgjbWV0ZW9yX3N1YnNjcmliZSksIGlmIGFueS5cbiAgICogQGxvY3VzIFNlcnZlclxuICAgKiBAbWVtYmVyT2YgU3Vic2NyaXB0aW9uXG4gICAqIEBpbnN0YW5jZVxuICAgKi9cbiAgcmVhZHk6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKHNlbGYuX2lzRGVhY3RpdmF0ZWQoKSlcbiAgICAgIHJldHVybjtcbiAgICBpZiAoIXNlbGYuX3N1YnNjcmlwdGlvbklkKVxuICAgICAgcmV0dXJuOyAgLy8gVW5uZWNlc3NhcnkgYnV0IGlnbm9yZWQgZm9yIHVuaXZlcnNhbCBzdWJcbiAgICBpZiAoIXNlbGYuX3JlYWR5KSB7XG4gICAgICBzZWxmLl9zZXNzaW9uLnNlbmRSZWFkeShbc2VsZi5fc3Vic2NyaXB0aW9uSWRdKTtcbiAgICAgIHNlbGYuX3JlYWR5ID0gdHJ1ZTtcbiAgICB9XG4gIH1cbn0pO1xuXG4vKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqL1xuLyogU2VydmVyICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKi9cbi8qKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiovXG5cblNlcnZlciA9IGZ1bmN0aW9uIChvcHRpb25zID0ge30pIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gIC8vIFRoZSBkZWZhdWx0IGhlYXJ0YmVhdCBpbnRlcnZhbCBpcyAzMCBzZWNvbmRzIG9uIHRoZSBzZXJ2ZXIgYW5kIDM1XG4gIC8vIHNlY29uZHMgb24gdGhlIGNsaWVudC4gIFNpbmNlIHRoZSBjbGllbnQgZG9lc24ndCBuZWVkIHRvIHNlbmQgYVxuICAvLyBwaW5nIGFzIGxvbmcgYXMgaXQgaXMgcmVjZWl2aW5nIHBpbmdzLCB0aGlzIG1lYW5zIHRoYXQgcGluZ3NcbiAgLy8gbm9ybWFsbHkgZ28gZnJvbSB0aGUgc2VydmVyIHRvIHRoZSBjbGllbnQuXG4gIC8vXG4gIC8vIE5vdGU6IFRyb3Bvc3BoZXJlIGRlcGVuZHMgb24gdGhlIGFiaWxpdHkgdG8gbXV0YXRlXG4gIC8vIE1ldGVvci5zZXJ2ZXIub3B0aW9ucy5oZWFydGJlYXRUaW1lb3V0ISBUaGlzIGlzIGEgaGFjaywgYnV0IGl0J3MgbGlmZS5cbiAgc2VsZi5vcHRpb25zID0ge1xuICAgIGhlYXJ0YmVhdEludGVydmFsOiAxNTAwMCxcbiAgICBoZWFydGJlYXRUaW1lb3V0OiAxNTAwMCxcbiAgICAvLyBGb3IgdGVzdGluZywgYWxsb3cgcmVzcG9uZGluZyB0byBwaW5ncyB0byBiZSBkaXNhYmxlZC5cbiAgICByZXNwb25kVG9QaW5nczogdHJ1ZSxcbiAgICBkZWZhdWx0UHVibGljYXRpb25TdHJhdGVneTogcHVibGljYXRpb25TdHJhdGVnaWVzLlNFUlZFUl9NRVJHRSxcbiAgICAuLi5vcHRpb25zLFxuICB9O1xuXG4gIC8vIE1hcCBvZiBjYWxsYmFja3MgdG8gY2FsbCB3aGVuIGEgbmV3IGNvbm5lY3Rpb24gY29tZXMgaW4gdG8gdGhlXG4gIC8vIHNlcnZlciBhbmQgY29tcGxldGVzIEREUCB2ZXJzaW9uIG5lZ290aWF0aW9uLiBVc2UgYW4gb2JqZWN0IGluc3RlYWRcbiAgLy8gb2YgYW4gYXJyYXkgc28gd2UgY2FuIHNhZmVseSByZW1vdmUgb25lIGZyb20gdGhlIGxpc3Qgd2hpbGVcbiAgLy8gaXRlcmF0aW5nIG92ZXIgaXQuXG4gIHNlbGYub25Db25uZWN0aW9uSG9vayA9IG5ldyBIb29rKHtcbiAgICBkZWJ1Z1ByaW50RXhjZXB0aW9uczogXCJvbkNvbm5lY3Rpb24gY2FsbGJhY2tcIlxuICB9KTtcblxuICAvLyBNYXAgb2YgY2FsbGJhY2tzIHRvIGNhbGwgd2hlbiBhIG5ldyBtZXNzYWdlIGNvbWVzIGluLlxuICBzZWxmLm9uTWVzc2FnZUhvb2sgPSBuZXcgSG9vayh7XG4gICAgZGVidWdQcmludEV4Y2VwdGlvbnM6IFwib25NZXNzYWdlIGNhbGxiYWNrXCJcbiAgfSk7XG5cbiAgc2VsZi5wdWJsaXNoX2hhbmRsZXJzID0ge307XG4gIHNlbGYudW5pdmVyc2FsX3B1Ymxpc2hfaGFuZGxlcnMgPSBbXTtcblxuICBzZWxmLm1ldGhvZF9oYW5kbGVycyA9IHt9O1xuXG4gIHNlbGYuX3B1YmxpY2F0aW9uU3RyYXRlZ2llcyA9IHt9O1xuXG4gIHNlbGYuc2Vzc2lvbnMgPSBuZXcgTWFwKCk7IC8vIG1hcCBmcm9tIGlkIHRvIHNlc3Npb25cblxuICBzZWxmLnN0cmVhbV9zZXJ2ZXIgPSBuZXcgU3RyZWFtU2VydmVyO1xuXG4gIHNlbGYuc3RyZWFtX3NlcnZlci5yZWdpc3RlcihmdW5jdGlvbiAoc29ja2V0KSB7XG4gICAgLy8gc29ja2V0IGltcGxlbWVudHMgdGhlIFNvY2tKU0Nvbm5lY3Rpb24gaW50ZXJmYWNlXG4gICAgc29ja2V0Ll9tZXRlb3JTZXNzaW9uID0gbnVsbDtcblxuICAgIHZhciBzZW5kRXJyb3IgPSBmdW5jdGlvbiAocmVhc29uLCBvZmZlbmRpbmdNZXNzYWdlKSB7XG4gICAgICB2YXIgbXNnID0ge21zZzogJ2Vycm9yJywgcmVhc29uOiByZWFzb259O1xuICAgICAgaWYgKG9mZmVuZGluZ01lc3NhZ2UpXG4gICAgICAgIG1zZy5vZmZlbmRpbmdNZXNzYWdlID0gb2ZmZW5kaW5nTWVzc2FnZTtcbiAgICAgIHNvY2tldC5zZW5kKEREUENvbW1vbi5zdHJpbmdpZnlERFAobXNnKSk7XG4gICAgfTtcblxuICAgIHNvY2tldC5vbignZGF0YScsIGZ1bmN0aW9uIChyYXdfbXNnKSB7XG4gICAgICBpZiAoTWV0ZW9yLl9wcmludFJlY2VpdmVkRERQKSB7XG4gICAgICAgIE1ldGVvci5fZGVidWcoXCJSZWNlaXZlZCBERFBcIiwgcmF3X21zZyk7XG4gICAgICB9XG4gICAgICB0cnkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHZhciBtc2cgPSBERFBDb21tb24ucGFyc2VERFAocmF3X21zZyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIHNlbmRFcnJvcignUGFyc2UgZXJyb3InKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG1zZyA9PT0gbnVsbCB8fCAhbXNnLm1zZykge1xuICAgICAgICAgIHNlbmRFcnJvcignQmFkIHJlcXVlc3QnLCBtc2cpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChtc2cubXNnID09PSAnY29ubmVjdCcpIHtcbiAgICAgICAgICBpZiAoc29ja2V0Ll9tZXRlb3JTZXNzaW9uKSB7XG4gICAgICAgICAgICBzZW5kRXJyb3IoXCJBbHJlYWR5IGNvbm5lY3RlZFwiLCBtc2cpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBGaWJlcihmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBzZWxmLl9oYW5kbGVDb25uZWN0KHNvY2tldCwgbXNnKTtcbiAgICAgICAgICB9KS5ydW4oKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXNvY2tldC5fbWV0ZW9yU2Vzc2lvbikge1xuICAgICAgICAgIHNlbmRFcnJvcignTXVzdCBjb25uZWN0IGZpcnN0JywgbXNnKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgc29ja2V0Ll9tZXRlb3JTZXNzaW9uLnByb2Nlc3NNZXNzYWdlKG1zZyk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIC8vIFhYWCBwcmludCBzdGFjayBuaWNlbHlcbiAgICAgICAgTWV0ZW9yLl9kZWJ1ZyhcIkludGVybmFsIGV4Y2VwdGlvbiB3aGlsZSBwcm9jZXNzaW5nIG1lc3NhZ2VcIiwgbXNnLCBlKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHNvY2tldC5vbignY2xvc2UnLCBmdW5jdGlvbiAoKSB7XG4gICAgICBpZiAoc29ja2V0Ll9tZXRlb3JTZXNzaW9uKSB7XG4gICAgICAgIEZpYmVyKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICBzb2NrZXQuX21ldGVvclNlc3Npb24uY2xvc2UoKTtcbiAgICAgICAgfSkucnVuKCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xufTtcblxuT2JqZWN0LmFzc2lnbihTZXJ2ZXIucHJvdG90eXBlLCB7XG5cbiAgLyoqXG4gICAqIEBzdW1tYXJ5IFJlZ2lzdGVyIGEgY2FsbGJhY2sgdG8gYmUgY2FsbGVkIHdoZW4gYSBuZXcgRERQIGNvbm5lY3Rpb24gaXMgbWFkZSB0byB0aGUgc2VydmVyLlxuICAgKiBAbG9jdXMgU2VydmVyXG4gICAqIEBwYXJhbSB7ZnVuY3Rpb259IGNhbGxiYWNrIFRoZSBmdW5jdGlvbiB0byBjYWxsIHdoZW4gYSBuZXcgRERQIGNvbm5lY3Rpb24gaXMgZXN0YWJsaXNoZWQuXG4gICAqIEBtZW1iZXJPZiBNZXRlb3JcbiAgICogQGltcG9ydEZyb21QYWNrYWdlIG1ldGVvclxuICAgKi9cbiAgb25Db25uZWN0aW9uOiBmdW5jdGlvbiAoZm4pIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgcmV0dXJuIHNlbGYub25Db25uZWN0aW9uSG9vay5yZWdpc3Rlcihmbik7XG4gIH0sXG5cbiAgLyoqXG4gICAqIEBzdW1tYXJ5IFNldCBwdWJsaWNhdGlvbiBzdHJhdGVneSBmb3IgdGhlIGdpdmVuIGNvbGxlY3Rpb24uIFB1YmxpY2F0aW9ucyBzdHJhdGVnaWVzIGFyZSBhdmFpbGFibGUgZnJvbSBgRERQU2VydmVyLnB1YmxpY2F0aW9uU3RyYXRlZ2llc2AuIFlvdSBjYWxsIHRoaXMgbWV0aG9kIGZyb20gYE1ldGVvci5zZXJ2ZXJgLCBsaWtlIGBNZXRlb3Iuc2VydmVyLnNldFB1YmxpY2F0aW9uU3RyYXRlZ3koKWBcbiAgICogQGxvY3VzIFNlcnZlclxuICAgKiBAYWxpYXMgc2V0UHVibGljYXRpb25TdHJhdGVneVxuICAgKiBAcGFyYW0gY29sbGVjdGlvbk5hbWUge1N0cmluZ31cbiAgICogQHBhcmFtIHN0cmF0ZWd5IHt7dXNlQ29sbGVjdGlvblZpZXc6IGJvb2xlYW4sIGRvQWNjb3VudGluZ0ZvckNvbGxlY3Rpb246IGJvb2xlYW59fVxuICAgKiBAbWVtYmVyT2YgTWV0ZW9yLnNlcnZlclxuICAgKiBAaW1wb3J0RnJvbVBhY2thZ2UgbWV0ZW9yXG4gICAqL1xuICBzZXRQdWJsaWNhdGlvblN0cmF0ZWd5KGNvbGxlY3Rpb25OYW1lLCBzdHJhdGVneSkge1xuICAgIGlmICghT2JqZWN0LnZhbHVlcyhwdWJsaWNhdGlvblN0cmF0ZWdpZXMpLmluY2x1ZGVzKHN0cmF0ZWd5KSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIG1lcmdlIHN0cmF0ZWd5OiAke3N0cmF0ZWd5fSBcbiAgICAgICAgZm9yIGNvbGxlY3Rpb24gJHtjb2xsZWN0aW9uTmFtZX1gKTtcbiAgICB9XG4gICAgdGhpcy5fcHVibGljYXRpb25TdHJhdGVnaWVzW2NvbGxlY3Rpb25OYW1lXSA9IHN0cmF0ZWd5O1xuICB9LFxuXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBHZXRzIHRoZSBwdWJsaWNhdGlvbiBzdHJhdGVneSBmb3IgdGhlIHJlcXVlc3RlZCBjb2xsZWN0aW9uLiBZb3UgY2FsbCB0aGlzIG1ldGhvZCBmcm9tIGBNZXRlb3Iuc2VydmVyYCwgbGlrZSBgTWV0ZW9yLnNlcnZlci5nZXRQdWJsaWNhdGlvblN0cmF0ZWd5KClgXG4gICAqIEBsb2N1cyBTZXJ2ZXJcbiAgICogQGFsaWFzIGdldFB1YmxpY2F0aW9uU3RyYXRlZ3lcbiAgICogQHBhcmFtIGNvbGxlY3Rpb25OYW1lIHtTdHJpbmd9XG4gICAqIEBtZW1iZXJPZiBNZXRlb3Iuc2VydmVyXG4gICAqIEBpbXBvcnRGcm9tUGFja2FnZSBtZXRlb3JcbiAgICogQHJldHVybiB7e3VzZUNvbGxlY3Rpb25WaWV3OiBib29sZWFuLCBkb0FjY291bnRpbmdGb3JDb2xsZWN0aW9uOiBib29sZWFufX1cbiAgICovXG4gIGdldFB1YmxpY2F0aW9uU3RyYXRlZ3koY29sbGVjdGlvbk5hbWUpIHtcbiAgICByZXR1cm4gdGhpcy5fcHVibGljYXRpb25TdHJhdGVnaWVzW2NvbGxlY3Rpb25OYW1lXVxuICAgICAgfHwgdGhpcy5vcHRpb25zLmRlZmF1bHRQdWJsaWNhdGlvblN0cmF0ZWd5O1xuICB9LFxuXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBSZWdpc3RlciBhIGNhbGxiYWNrIHRvIGJlIGNhbGxlZCB3aGVuIGEgbmV3IEREUCBtZXNzYWdlIGlzIHJlY2VpdmVkLlxuICAgKiBAbG9jdXMgU2VydmVyXG4gICAqIEBwYXJhbSB7ZnVuY3Rpb259IGNhbGxiYWNrIFRoZSBmdW5jdGlvbiB0byBjYWxsIHdoZW4gYSBuZXcgRERQIG1lc3NhZ2UgaXMgcmVjZWl2ZWQuXG4gICAqIEBtZW1iZXJPZiBNZXRlb3JcbiAgICogQGltcG9ydEZyb21QYWNrYWdlIG1ldGVvclxuICAgKi9cbiAgb25NZXNzYWdlOiBmdW5jdGlvbiAoZm4pIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgcmV0dXJuIHNlbGYub25NZXNzYWdlSG9vay5yZWdpc3Rlcihmbik7XG4gIH0sXG5cbiAgX2hhbmRsZUNvbm5lY3Q6IGZ1bmN0aW9uIChzb2NrZXQsIG1zZykge1xuICAgIHZhciBzZWxmID0gdGhpcztcblxuICAgIC8vIFRoZSBjb25uZWN0IG1lc3NhZ2UgbXVzdCBzcGVjaWZ5IGEgdmVyc2lvbiBhbmQgYW4gYXJyYXkgb2Ygc3VwcG9ydGVkXG4gICAgLy8gdmVyc2lvbnMsIGFuZCBpdCBtdXN0IGNsYWltIHRvIHN1cHBvcnQgd2hhdCBpdCBpcyBwcm9wb3NpbmcuXG4gICAgaWYgKCEodHlwZW9mIChtc2cudmVyc2lvbikgPT09ICdzdHJpbmcnICYmXG4gICAgICAgICAgXy5pc0FycmF5KG1zZy5zdXBwb3J0KSAmJlxuICAgICAgICAgIF8uYWxsKG1zZy5zdXBwb3J0LCBfLmlzU3RyaW5nKSAmJlxuICAgICAgICAgIF8uY29udGFpbnMobXNnLnN1cHBvcnQsIG1zZy52ZXJzaW9uKSkpIHtcbiAgICAgIHNvY2tldC5zZW5kKEREUENvbW1vbi5zdHJpbmdpZnlERFAoe21zZzogJ2ZhaWxlZCcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZlcnNpb246IEREUENvbW1vbi5TVVBQT1JURURfRERQX1ZFUlNJT05TWzBdfSkpO1xuICAgICAgc29ja2V0LmNsb3NlKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gSW4gdGhlIGZ1dHVyZSwgaGFuZGxlIHNlc3Npb24gcmVzdW1wdGlvbjogc29tZXRoaW5nIGxpa2U6XG4gICAgLy8gIHNvY2tldC5fbWV0ZW9yU2Vzc2lvbiA9IHNlbGYuc2Vzc2lvbnNbbXNnLnNlc3Npb25dXG4gICAgdmFyIHZlcnNpb24gPSBjYWxjdWxhdGVWZXJzaW9uKG1zZy5zdXBwb3J0LCBERFBDb21tb24uU1VQUE9SVEVEX0REUF9WRVJTSU9OUyk7XG5cbiAgICBpZiAobXNnLnZlcnNpb24gIT09IHZlcnNpb24pIHtcbiAgICAgIC8vIFRoZSBiZXN0IHZlcnNpb24gdG8gdXNlIChhY2NvcmRpbmcgdG8gdGhlIGNsaWVudCdzIHN0YXRlZCBwcmVmZXJlbmNlcylcbiAgICAgIC8vIGlzIG5vdCB0aGUgb25lIHRoZSBjbGllbnQgaXMgdHJ5aW5nIHRvIHVzZS4gSW5mb3JtIHRoZW0gYWJvdXQgdGhlIGJlc3RcbiAgICAgIC8vIHZlcnNpb24gdG8gdXNlLlxuICAgICAgc29ja2V0LnNlbmQoRERQQ29tbW9uLnN0cmluZ2lmeUREUCh7bXNnOiAnZmFpbGVkJywgdmVyc2lvbjogdmVyc2lvbn0pKTtcbiAgICAgIHNvY2tldC5jbG9zZSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIFlheSwgdmVyc2lvbiBtYXRjaGVzISBDcmVhdGUgYSBuZXcgc2Vzc2lvbi5cbiAgICAvLyBOb3RlOiBUcm9wb3NwaGVyZSBkZXBlbmRzIG9uIHRoZSBhYmlsaXR5IHRvIG11dGF0ZVxuICAgIC8vIE1ldGVvci5zZXJ2ZXIub3B0aW9ucy5oZWFydGJlYXRUaW1lb3V0ISBUaGlzIGlzIGEgaGFjaywgYnV0IGl0J3MgbGlmZS5cbiAgICBzb2NrZXQuX21ldGVvclNlc3Npb24gPSBuZXcgU2Vzc2lvbihzZWxmLCB2ZXJzaW9uLCBzb2NrZXQsIHNlbGYub3B0aW9ucyk7XG4gICAgc2VsZi5zZXNzaW9ucy5zZXQoc29ja2V0Ll9tZXRlb3JTZXNzaW9uLmlkLCBzb2NrZXQuX21ldGVvclNlc3Npb24pO1xuICAgIHNlbGYub25Db25uZWN0aW9uSG9vay5lYWNoKGZ1bmN0aW9uIChjYWxsYmFjaykge1xuICAgICAgaWYgKHNvY2tldC5fbWV0ZW9yU2Vzc2lvbilcbiAgICAgICAgY2FsbGJhY2soc29ja2V0Ll9tZXRlb3JTZXNzaW9uLmNvbm5lY3Rpb25IYW5kbGUpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSk7XG4gIH0sXG4gIC8qKlxuICAgKiBSZWdpc3RlciBhIHB1Ymxpc2ggaGFuZGxlciBmdW5jdGlvbi5cbiAgICpcbiAgICogQHBhcmFtIG5hbWUge1N0cmluZ30gaWRlbnRpZmllciBmb3IgcXVlcnlcbiAgICogQHBhcmFtIGhhbmRsZXIge0Z1bmN0aW9ufSBwdWJsaXNoIGhhbmRsZXJcbiAgICogQHBhcmFtIG9wdGlvbnMge09iamVjdH1cbiAgICpcbiAgICogU2VydmVyIHdpbGwgY2FsbCBoYW5kbGVyIGZ1bmN0aW9uIG9uIGVhY2ggbmV3IHN1YnNjcmlwdGlvbixcbiAgICogZWl0aGVyIHdoZW4gcmVjZWl2aW5nIEREUCBzdWIgbWVzc2FnZSBmb3IgYSBuYW1lZCBzdWJzY3JpcHRpb24sIG9yIG9uXG4gICAqIEREUCBjb25uZWN0IGZvciBhIHVuaXZlcnNhbCBzdWJzY3JpcHRpb24uXG4gICAqXG4gICAqIElmIG5hbWUgaXMgbnVsbCwgdGhpcyB3aWxsIGJlIGEgc3Vic2NyaXB0aW9uIHRoYXQgaXNcbiAgICogYXV0b21hdGljYWxseSBlc3RhYmxpc2hlZCBhbmQgcGVybWFuZW50bHkgb24gZm9yIGFsbCBjb25uZWN0ZWRcbiAgICogY2xpZW50LCBpbnN0ZWFkIG9mIGEgc3Vic2NyaXB0aW9uIHRoYXQgY2FuIGJlIHR1cm5lZCBvbiBhbmQgb2ZmXG4gICAqIHdpdGggc3Vic2NyaWJlKCkuXG4gICAqXG4gICAqIG9wdGlvbnMgdG8gY29udGFpbjpcbiAgICogIC0gKG1vc3RseSBpbnRlcm5hbCkgaXNfYXV0bzogdHJ1ZSBpZiBnZW5lcmF0ZWQgYXV0b21hdGljYWxseVxuICAgKiAgICBmcm9tIGFuIGF1dG9wdWJsaXNoIGhvb2suIHRoaXMgaXMgZm9yIGNvc21ldGljIHB1cnBvc2VzIG9ubHlcbiAgICogICAgKGl0IGxldHMgdXMgZGV0ZXJtaW5lIHdoZXRoZXIgdG8gcHJpbnQgYSB3YXJuaW5nIHN1Z2dlc3RpbmdcbiAgICogICAgdGhhdCB5b3UgdHVybiBvZmYgYXV0b3B1Ymxpc2gpLlxuICAgKi9cblxuICAvKipcbiAgICogQHN1bW1hcnkgUHVibGlzaCBhIHJlY29yZCBzZXQuXG4gICAqIEBtZW1iZXJPZiBNZXRlb3JcbiAgICogQGltcG9ydEZyb21QYWNrYWdlIG1ldGVvclxuICAgKiBAbG9jdXMgU2VydmVyXG4gICAqIEBwYXJhbSB7U3RyaW5nfE9iamVjdH0gbmFtZSBJZiBTdHJpbmcsIG5hbWUgb2YgdGhlIHJlY29yZCBzZXQuICBJZiBPYmplY3QsIHB1YmxpY2F0aW9ucyBEaWN0aW9uYXJ5IG9mIHB1Ymxpc2ggZnVuY3Rpb25zIGJ5IG5hbWUuICBJZiBgbnVsbGAsIHRoZSBzZXQgaGFzIG5vIG5hbWUsIGFuZCB0aGUgcmVjb3JkIHNldCBpcyBhdXRvbWF0aWNhbGx5IHNlbnQgdG8gYWxsIGNvbm5lY3RlZCBjbGllbnRzLlxuICAgKiBAcGFyYW0ge0Z1bmN0aW9ufSBmdW5jIEZ1bmN0aW9uIGNhbGxlZCBvbiB0aGUgc2VydmVyIGVhY2ggdGltZSBhIGNsaWVudCBzdWJzY3JpYmVzLiAgSW5zaWRlIHRoZSBmdW5jdGlvbiwgYHRoaXNgIGlzIHRoZSBwdWJsaXNoIGhhbmRsZXIgb2JqZWN0LCBkZXNjcmliZWQgYmVsb3cuICBJZiB0aGUgY2xpZW50IHBhc3NlZCBhcmd1bWVudHMgdG8gYHN1YnNjcmliZWAsIHRoZSBmdW5jdGlvbiBpcyBjYWxsZWQgd2l0aCB0aGUgc2FtZSBhcmd1bWVudHMuXG4gICAqL1xuICBwdWJsaXNoOiBmdW5jdGlvbiAobmFtZSwgaGFuZGxlciwgb3B0aW9ucykge1xuICAgIHZhciBzZWxmID0gdGhpcztcblxuICAgIGlmICghIF8uaXNPYmplY3QobmFtZSkpIHtcbiAgICAgIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9O1xuXG4gICAgICBpZiAobmFtZSAmJiBuYW1lIGluIHNlbGYucHVibGlzaF9oYW5kbGVycykge1xuICAgICAgICBNZXRlb3IuX2RlYnVnKFwiSWdub3JpbmcgZHVwbGljYXRlIHB1Ymxpc2ggbmFtZWQgJ1wiICsgbmFtZSArIFwiJ1wiKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBpZiAoUGFja2FnZS5hdXRvcHVibGlzaCAmJiAhb3B0aW9ucy5pc19hdXRvKSB7XG4gICAgICAgIC8vIFRoZXkgaGF2ZSBhdXRvcHVibGlzaCBvbiwgeWV0IHRoZXkncmUgdHJ5aW5nIHRvIG1hbnVhbGx5XG4gICAgICAgIC8vIHBpY2sgc3R1ZmYgdG8gcHVibGlzaC4gVGhleSBwcm9iYWJseSBzaG91bGQgdHVybiBvZmZcbiAgICAgICAgLy8gYXV0b3B1Ymxpc2guIChUaGlzIGNoZWNrIGlzbid0IHBlcmZlY3QgLS0gaWYgeW91IGNyZWF0ZSBhXG4gICAgICAgIC8vIHB1Ymxpc2ggYmVmb3JlIHlvdSB0dXJuIG9uIGF1dG9wdWJsaXNoLCBpdCB3b24ndCBjYXRjaFxuICAgICAgICAvLyBpdCwgYnV0IHRoaXMgd2lsbCBkZWZpbml0ZWx5IGhhbmRsZSB0aGUgc2ltcGxlIGNhc2Ugd2hlcmVcbiAgICAgICAgLy8geW91J3ZlIGFkZGVkIHRoZSBhdXRvcHVibGlzaCBwYWNrYWdlIHRvIHlvdXIgYXBwLCBhbmQgYXJlXG4gICAgICAgIC8vIGNhbGxpbmcgcHVibGlzaCBmcm9tIHlvdXIgYXBwIGNvZGUpLlxuICAgICAgICBpZiAoIXNlbGYud2FybmVkX2Fib3V0X2F1dG9wdWJsaXNoKSB7XG4gICAgICAgICAgc2VsZi53YXJuZWRfYWJvdXRfYXV0b3B1Ymxpc2ggPSB0cnVlO1xuICAgICAgICAgIE1ldGVvci5fZGVidWcoXG4gICAgXCIqKiBZb3UndmUgc2V0IHVwIHNvbWUgZGF0YSBzdWJzY3JpcHRpb25zIHdpdGggTWV0ZW9yLnB1Ymxpc2goKSwgYnV0XFxuXCIgK1xuICAgIFwiKiogeW91IHN0aWxsIGhhdmUgYXV0b3B1Ymxpc2ggdHVybmVkIG9uLiBCZWNhdXNlIGF1dG9wdWJsaXNoIGlzIHN0aWxsXFxuXCIgK1xuICAgIFwiKiogb24sIHlvdXIgTWV0ZW9yLnB1Ymxpc2goKSBjYWxscyB3b24ndCBoYXZlIG11Y2ggZWZmZWN0LiBBbGwgZGF0YVxcblwiICtcbiAgICBcIioqIHdpbGwgc3RpbGwgYmUgc2VudCB0byBhbGwgY2xpZW50cy5cXG5cIiArXG4gICAgXCIqKlxcblwiICtcbiAgICBcIioqIFR1cm4gb2ZmIGF1dG9wdWJsaXNoIGJ5IHJlbW92aW5nIHRoZSBhdXRvcHVibGlzaCBwYWNrYWdlOlxcblwiICtcbiAgICBcIioqXFxuXCIgK1xuICAgIFwiKiogICAkIG1ldGVvciByZW1vdmUgYXV0b3B1Ymxpc2hcXG5cIiArXG4gICAgXCIqKlxcblwiICtcbiAgICBcIioqIC4uIGFuZCBtYWtlIHN1cmUgeW91IGhhdmUgTWV0ZW9yLnB1Ymxpc2goKSBhbmQgTWV0ZW9yLnN1YnNjcmliZSgpIGNhbGxzXFxuXCIgK1xuICAgIFwiKiogZm9yIGVhY2ggY29sbGVjdGlvbiB0aGF0IHlvdSB3YW50IGNsaWVudHMgdG8gc2VlLlxcblwiKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAobmFtZSlcbiAgICAgICAgc2VsZi5wdWJsaXNoX2hhbmRsZXJzW25hbWVdID0gaGFuZGxlcjtcbiAgICAgIGVsc2Uge1xuICAgICAgICBzZWxmLnVuaXZlcnNhbF9wdWJsaXNoX2hhbmRsZXJzLnB1c2goaGFuZGxlcik7XG4gICAgICAgIC8vIFNwaW4gdXAgdGhlIG5ldyBwdWJsaXNoZXIgb24gYW55IGV4aXN0aW5nIHNlc3Npb24gdG9vLiBSdW4gZWFjaFxuICAgICAgICAvLyBzZXNzaW9uJ3Mgc3Vic2NyaXB0aW9uIGluIGEgbmV3IEZpYmVyLCBzbyB0aGF0IHRoZXJlJ3Mgbm8gY2hhbmdlIGZvclxuICAgICAgICAvLyBzZWxmLnNlc3Npb25zIHRvIGNoYW5nZSB3aGlsZSB3ZSdyZSBydW5uaW5nIHRoaXMgbG9vcC5cbiAgICAgICAgc2VsZi5zZXNzaW9ucy5mb3JFYWNoKGZ1bmN0aW9uIChzZXNzaW9uKSB7XG4gICAgICAgICAgaWYgKCFzZXNzaW9uLl9kb250U3RhcnROZXdVbml2ZXJzYWxTdWJzKSB7XG4gICAgICAgICAgICBGaWJlcihmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgc2Vzc2lvbi5fc3RhcnRTdWJzY3JpcHRpb24oaGFuZGxlcik7XG4gICAgICAgICAgICB9KS5ydW4oKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICBlbHNle1xuICAgICAgXy5lYWNoKG5hbWUsIGZ1bmN0aW9uKHZhbHVlLCBrZXkpIHtcbiAgICAgICAgc2VsZi5wdWJsaXNoKGtleSwgdmFsdWUsIHt9KTtcbiAgICAgIH0pO1xuICAgIH1cbiAgfSxcblxuICBfcmVtb3ZlU2Vzc2lvbjogZnVuY3Rpb24gKHNlc3Npb24pIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgc2VsZi5zZXNzaW9ucy5kZWxldGUoc2Vzc2lvbi5pZCk7XG4gIH0sXG5cbiAgLyoqXG4gICAqIEBzdW1tYXJ5IERlZmluZXMgZnVuY3Rpb25zIHRoYXQgY2FuIGJlIGludm9rZWQgb3ZlciB0aGUgbmV0d29yayBieSBjbGllbnRzLlxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQHBhcmFtIHtPYmplY3R9IG1ldGhvZHMgRGljdGlvbmFyeSB3aG9zZSBrZXlzIGFyZSBtZXRob2QgbmFtZXMgYW5kIHZhbHVlcyBhcmUgZnVuY3Rpb25zLlxuICAgKiBAbWVtYmVyT2YgTWV0ZW9yXG4gICAqIEBpbXBvcnRGcm9tUGFja2FnZSBtZXRlb3JcbiAgICovXG4gIG1ldGhvZHM6IGZ1bmN0aW9uIChtZXRob2RzKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIF8uZWFjaChtZXRob2RzLCBmdW5jdGlvbiAoZnVuYywgbmFtZSkge1xuICAgICAgaWYgKHR5cGVvZiBmdW5jICE9PSAnZnVuY3Rpb24nKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJNZXRob2QgJ1wiICsgbmFtZSArIFwiJyBtdXN0IGJlIGEgZnVuY3Rpb25cIik7XG4gICAgICBpZiAoc2VsZi5tZXRob2RfaGFuZGxlcnNbbmFtZV0pXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkEgbWV0aG9kIG5hbWVkICdcIiArIG5hbWUgKyBcIicgaXMgYWxyZWFkeSBkZWZpbmVkXCIpO1xuICAgICAgc2VsZi5tZXRob2RfaGFuZGxlcnNbbmFtZV0gPSBmdW5jO1xuICAgIH0pO1xuICB9LFxuXG4gIGNhbGw6IGZ1bmN0aW9uIChuYW1lLCAuLi5hcmdzKSB7XG4gICAgaWYgKGFyZ3MubGVuZ3RoICYmIHR5cGVvZiBhcmdzW2FyZ3MubGVuZ3RoIC0gMV0gPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgLy8gSWYgaXQncyBhIGZ1bmN0aW9uLCB0aGUgbGFzdCBhcmd1bWVudCBpcyB0aGUgcmVzdWx0IGNhbGxiYWNrLCBub3RcbiAgICAgIC8vIGEgcGFyYW1ldGVyIHRvIHRoZSByZW1vdGUgbWV0aG9kLlxuICAgICAgdmFyIGNhbGxiYWNrID0gYXJncy5wb3AoKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy5hcHBseShuYW1lLCBhcmdzLCBjYWxsYmFjayk7XG4gIH0sXG5cbiAgLy8gQSB2ZXJzaW9uIG9mIHRoZSBjYWxsIG1ldGhvZCB0aGF0IGFsd2F5cyByZXR1cm5zIGEgUHJvbWlzZS5cbiAgY2FsbEFzeW5jOiBmdW5jdGlvbiAobmFtZSwgLi4uYXJncykge1xuICAgIHJldHVybiB0aGlzLmFwcGx5QXN5bmMobmFtZSwgYXJncyk7XG4gIH0sXG5cbiAgYXBwbHk6IGZ1bmN0aW9uIChuYW1lLCBhcmdzLCBvcHRpb25zLCBjYWxsYmFjaykge1xuICAgIC8vIFdlIHdlcmUgcGFzc2VkIDMgYXJndW1lbnRzLiBUaGV5IG1heSBiZSBlaXRoZXIgKG5hbWUsIGFyZ3MsIG9wdGlvbnMpXG4gICAgLy8gb3IgKG5hbWUsIGFyZ3MsIGNhbGxiYWNrKVxuICAgIGlmICghIGNhbGxiYWNrICYmIHR5cGVvZiBvcHRpb25zID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgICBvcHRpb25zID0ge307XG4gICAgfSBlbHNlIHtcbiAgICAgIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9O1xuICAgIH1cblxuICAgIGNvbnN0IHByb21pc2UgPSB0aGlzLmFwcGx5QXN5bmMobmFtZSwgYXJncywgb3B0aW9ucyk7XG5cbiAgICAvLyBSZXR1cm4gdGhlIHJlc3VsdCBpbiB3aGljaGV2ZXIgd2F5IHRoZSBjYWxsZXIgYXNrZWQgZm9yIGl0LiBOb3RlIHRoYXQgd2VcbiAgICAvLyBkbyBOT1QgYmxvY2sgb24gdGhlIHdyaXRlIGZlbmNlIGluIGFuIGFuYWxvZ291cyB3YXkgdG8gaG93IHRoZSBjbGllbnRcbiAgICAvLyBibG9ja3Mgb24gdGhlIHJlbGV2YW50IGRhdGEgYmVpbmcgdmlzaWJsZSwgc28geW91IGFyZSBOT1QgZ3VhcmFudGVlZCB0aGF0XG4gICAgLy8gY3Vyc29yIG9ic2VydmUgY2FsbGJhY2tzIGhhdmUgZmlyZWQgd2hlbiB5b3VyIGNhbGxiYWNrIGlzIGludm9rZWQuIChXZVxuICAgIC8vIGNhbiBjaGFuZ2UgdGhpcyBpZiB0aGVyZSdzIGEgcmVhbCB1c2UgY2FzZSkuXG4gICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICBwcm9taXNlLnRoZW4oXG4gICAgICAgIHJlc3VsdCA9PiBjYWxsYmFjayh1bmRlZmluZWQsIHJlc3VsdCksXG4gICAgICAgIGV4Y2VwdGlvbiA9PiBjYWxsYmFjayhleGNlcHRpb24pXG4gICAgICApO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gcHJvbWlzZS5hd2FpdCgpO1xuICAgIH1cbiAgfSxcblxuICAvLyBAcGFyYW0gb3B0aW9ucyB7T3B0aW9uYWwgT2JqZWN0fVxuICBhcHBseUFzeW5jOiBmdW5jdGlvbiAobmFtZSwgYXJncywgb3B0aW9ucykge1xuICAgIC8vIFJ1biB0aGUgaGFuZGxlclxuICAgIHZhciBoYW5kbGVyID0gdGhpcy5tZXRob2RfaGFuZGxlcnNbbmFtZV07XG4gICAgaWYgKCEgaGFuZGxlcikge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFxuICAgICAgICBuZXcgTWV0ZW9yLkVycm9yKDQwNCwgYE1ldGhvZCAnJHtuYW1lfScgbm90IGZvdW5kYClcbiAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gSWYgdGhpcyBpcyBhIG1ldGhvZCBjYWxsIGZyb20gd2l0aGluIGFub3RoZXIgbWV0aG9kIG9yIHB1Ymxpc2ggZnVuY3Rpb24sXG4gICAgLy8gZ2V0IHRoZSB1c2VyIHN0YXRlIGZyb20gdGhlIG91dGVyIG1ldGhvZCBvciBwdWJsaXNoIGZ1bmN0aW9uLCBvdGhlcndpc2VcbiAgICAvLyBkb24ndCBhbGxvdyBzZXRVc2VySWQgdG8gYmUgY2FsbGVkXG4gICAgdmFyIHVzZXJJZCA9IG51bGw7XG4gICAgdmFyIHNldFVzZXJJZCA9IGZ1bmN0aW9uKCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQ2FuJ3QgY2FsbCBzZXRVc2VySWQgb24gYSBzZXJ2ZXIgaW5pdGlhdGVkIG1ldGhvZCBjYWxsXCIpO1xuICAgIH07XG4gICAgdmFyIGNvbm5lY3Rpb24gPSBudWxsO1xuICAgIHZhciBjdXJyZW50TWV0aG9kSW52b2NhdGlvbiA9IEREUC5fQ3VycmVudE1ldGhvZEludm9jYXRpb24uZ2V0KCk7XG4gICAgdmFyIGN1cnJlbnRQdWJsaWNhdGlvbkludm9jYXRpb24gPSBERFAuX0N1cnJlbnRQdWJsaWNhdGlvbkludm9jYXRpb24uZ2V0KCk7XG4gICAgdmFyIHJhbmRvbVNlZWQgPSBudWxsO1xuICAgIGlmIChjdXJyZW50TWV0aG9kSW52b2NhdGlvbikge1xuICAgICAgdXNlcklkID0gY3VycmVudE1ldGhvZEludm9jYXRpb24udXNlcklkO1xuICAgICAgc2V0VXNlcklkID0gZnVuY3Rpb24odXNlcklkKSB7XG4gICAgICAgIGN1cnJlbnRNZXRob2RJbnZvY2F0aW9uLnNldFVzZXJJZCh1c2VySWQpO1xuICAgICAgfTtcbiAgICAgIGNvbm5lY3Rpb24gPSBjdXJyZW50TWV0aG9kSW52b2NhdGlvbi5jb25uZWN0aW9uO1xuICAgICAgcmFuZG9tU2VlZCA9IEREUENvbW1vbi5tYWtlUnBjU2VlZChjdXJyZW50TWV0aG9kSW52b2NhdGlvbiwgbmFtZSk7XG4gICAgfSBlbHNlIGlmIChjdXJyZW50UHVibGljYXRpb25JbnZvY2F0aW9uKSB7XG4gICAgICB1c2VySWQgPSBjdXJyZW50UHVibGljYXRpb25JbnZvY2F0aW9uLnVzZXJJZDtcbiAgICAgIHNldFVzZXJJZCA9IGZ1bmN0aW9uKHVzZXJJZCkge1xuICAgICAgICBjdXJyZW50UHVibGljYXRpb25JbnZvY2F0aW9uLl9zZXNzaW9uLl9zZXRVc2VySWQodXNlcklkKTtcbiAgICAgIH07XG4gICAgICBjb25uZWN0aW9uID0gY3VycmVudFB1YmxpY2F0aW9uSW52b2NhdGlvbi5jb25uZWN0aW9uO1xuICAgIH1cblxuICAgIHZhciBpbnZvY2F0aW9uID0gbmV3IEREUENvbW1vbi5NZXRob2RJbnZvY2F0aW9uKHtcbiAgICAgIGlzU2ltdWxhdGlvbjogZmFsc2UsXG4gICAgICB1c2VySWQsXG4gICAgICBzZXRVc2VySWQsXG4gICAgICBjb25uZWN0aW9uLFxuICAgICAgcmFuZG9tU2VlZFxuICAgIH0pO1xuXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKHJlc29sdmUgPT4gcmVzb2x2ZShcbiAgICAgIEREUC5fQ3VycmVudE1ldGhvZEludm9jYXRpb24ud2l0aFZhbHVlKFxuICAgICAgICBpbnZvY2F0aW9uLFxuICAgICAgICAoKSA9PiBtYXliZUF1ZGl0QXJndW1lbnRDaGVja3MoXG4gICAgICAgICAgaGFuZGxlciwgaW52b2NhdGlvbiwgRUpTT04uY2xvbmUoYXJncyksXG4gICAgICAgICAgXCJpbnRlcm5hbCBjYWxsIHRvICdcIiArIG5hbWUgKyBcIidcIlxuICAgICAgICApXG4gICAgICApXG4gICAgKSkudGhlbihFSlNPTi5jbG9uZSk7XG4gIH0sXG5cbiAgX3VybEZvclNlc3Npb246IGZ1bmN0aW9uIChzZXNzaW9uSWQpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgdmFyIHNlc3Npb24gPSBzZWxmLnNlc3Npb25zLmdldChzZXNzaW9uSWQpO1xuICAgIGlmIChzZXNzaW9uKVxuICAgICAgcmV0dXJuIHNlc3Npb24uX3NvY2tldFVybDtcbiAgICBlbHNlXG4gICAgICByZXR1cm4gbnVsbDtcbiAgfVxufSk7XG5cbnZhciBjYWxjdWxhdGVWZXJzaW9uID0gZnVuY3Rpb24gKGNsaWVudFN1cHBvcnRlZFZlcnNpb25zLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2VydmVyU3VwcG9ydGVkVmVyc2lvbnMpIHtcbiAgdmFyIGNvcnJlY3RWZXJzaW9uID0gXy5maW5kKGNsaWVudFN1cHBvcnRlZFZlcnNpb25zLCBmdW5jdGlvbiAodmVyc2lvbikge1xuICAgIHJldHVybiBfLmNvbnRhaW5zKHNlcnZlclN1cHBvcnRlZFZlcnNpb25zLCB2ZXJzaW9uKTtcbiAgfSk7XG4gIGlmICghY29ycmVjdFZlcnNpb24pIHtcbiAgICBjb3JyZWN0VmVyc2lvbiA9IHNlcnZlclN1cHBvcnRlZFZlcnNpb25zWzBdO1xuICB9XG4gIHJldHVybiBjb3JyZWN0VmVyc2lvbjtcbn07XG5cbkREUFNlcnZlci5fY2FsY3VsYXRlVmVyc2lvbiA9IGNhbGN1bGF0ZVZlcnNpb247XG5cblxuLy8gXCJibGluZFwiIGV4Y2VwdGlvbnMgb3RoZXIgdGhhbiB0aG9zZSB0aGF0IHdlcmUgZGVsaWJlcmF0ZWx5IHRocm93biB0byBzaWduYWxcbi8vIGVycm9ycyB0byB0aGUgY2xpZW50XG52YXIgd3JhcEludGVybmFsRXhjZXB0aW9uID0gZnVuY3Rpb24gKGV4Y2VwdGlvbiwgY29udGV4dCkge1xuICBpZiAoIWV4Y2VwdGlvbikgcmV0dXJuIGV4Y2VwdGlvbjtcblxuICAvLyBUbyBhbGxvdyBwYWNrYWdlcyB0byB0aHJvdyBlcnJvcnMgaW50ZW5kZWQgZm9yIHRoZSBjbGllbnQgYnV0IG5vdCBoYXZlIHRvXG4gIC8vIGRlcGVuZCBvbiB0aGUgTWV0ZW9yLkVycm9yIGNsYXNzLCBgaXNDbGllbnRTYWZlYCBjYW4gYmUgc2V0IHRvIHRydWUgb24gYW55XG4gIC8vIGVycm9yIGJlZm9yZSBpdCBpcyB0aHJvd24uXG4gIGlmIChleGNlcHRpb24uaXNDbGllbnRTYWZlKSB7XG4gICAgaWYgKCEoZXhjZXB0aW9uIGluc3RhbmNlb2YgTWV0ZW9yLkVycm9yKSkge1xuICAgICAgY29uc3Qgb3JpZ2luYWxNZXNzYWdlID0gZXhjZXB0aW9uLm1lc3NhZ2U7XG4gICAgICBleGNlcHRpb24gPSBuZXcgTWV0ZW9yLkVycm9yKGV4Y2VwdGlvbi5lcnJvciwgZXhjZXB0aW9uLnJlYXNvbiwgZXhjZXB0aW9uLmRldGFpbHMpO1xuICAgICAgZXhjZXB0aW9uLm1lc3NhZ2UgPSBvcmlnaW5hbE1lc3NhZ2U7XG4gICAgfVxuICAgIHJldHVybiBleGNlcHRpb247XG4gIH1cblxuICAvLyBUZXN0cyBjYW4gc2V0IHRoZSAnX2V4cGVjdGVkQnlUZXN0JyBmbGFnIG9uIGFuIGV4Y2VwdGlvbiBzbyBpdCB3b24ndCBnbyB0b1xuICAvLyB0aGUgc2VydmVyIGxvZy5cbiAgaWYgKCFleGNlcHRpb24uX2V4cGVjdGVkQnlUZXN0KSB7XG4gICAgTWV0ZW9yLl9kZWJ1ZyhcIkV4Y2VwdGlvbiBcIiArIGNvbnRleHQsIGV4Y2VwdGlvbi5zdGFjayk7XG4gICAgaWYgKGV4Y2VwdGlvbi5zYW5pdGl6ZWRFcnJvcikge1xuICAgICAgTWV0ZW9yLl9kZWJ1ZyhcIlNhbml0aXplZCBhbmQgcmVwb3J0ZWQgdG8gdGhlIGNsaWVudCBhczpcIiwgZXhjZXB0aW9uLnNhbml0aXplZEVycm9yKTtcbiAgICAgIE1ldGVvci5fZGVidWcoKTtcbiAgICB9XG4gIH1cblxuICAvLyBEaWQgdGhlIGVycm9yIGNvbnRhaW4gbW9yZSBkZXRhaWxzIHRoYXQgY291bGQgaGF2ZSBiZWVuIHVzZWZ1bCBpZiBjYXVnaHQgaW5cbiAgLy8gc2VydmVyIGNvZGUgKG9yIGlmIHRocm93biBmcm9tIG5vbi1jbGllbnQtb3JpZ2luYXRlZCBjb2RlKSwgYnV0IGFsc29cbiAgLy8gcHJvdmlkZWQgYSBcInNhbml0aXplZFwiIHZlcnNpb24gd2l0aCBtb3JlIGNvbnRleHQgdGhhbiA1MDAgSW50ZXJuYWwgc2VydmVyXG4gIC8vIGVycm9yPyBVc2UgdGhhdC5cbiAgaWYgKGV4Y2VwdGlvbi5zYW5pdGl6ZWRFcnJvcikge1xuICAgIGlmIChleGNlcHRpb24uc2FuaXRpemVkRXJyb3IuaXNDbGllbnRTYWZlKVxuICAgICAgcmV0dXJuIGV4Y2VwdGlvbi5zYW5pdGl6ZWRFcnJvcjtcbiAgICBNZXRlb3IuX2RlYnVnKFwiRXhjZXB0aW9uIFwiICsgY29udGV4dCArIFwiIHByb3ZpZGVzIGEgc2FuaXRpemVkRXJyb3IgdGhhdCBcIiArXG4gICAgICAgICAgICAgICAgICBcImRvZXMgbm90IGhhdmUgaXNDbGllbnRTYWZlIHByb3BlcnR5IHNldDsgaWdub3JpbmdcIik7XG4gIH1cblxuICByZXR1cm4gbmV3IE1ldGVvci5FcnJvcig1MDAsIFwiSW50ZXJuYWwgc2VydmVyIGVycm9yXCIpO1xufTtcblxuXG4vLyBBdWRpdCBhcmd1bWVudCBjaGVja3MsIGlmIHRoZSBhdWRpdC1hcmd1bWVudC1jaGVja3MgcGFja2FnZSBleGlzdHMgKGl0IGlzIGFcbi8vIHdlYWsgZGVwZW5kZW5jeSBvZiB0aGlzIHBhY2thZ2UpLlxudmFyIG1heWJlQXVkaXRBcmd1bWVudENoZWNrcyA9IGZ1bmN0aW9uIChmLCBjb250ZXh0LCBhcmdzLCBkZXNjcmlwdGlvbikge1xuICBhcmdzID0gYXJncyB8fCBbXTtcbiAgaWYgKFBhY2thZ2VbJ2F1ZGl0LWFyZ3VtZW50LWNoZWNrcyddKSB7XG4gICAgcmV0dXJuIE1hdGNoLl9mYWlsSWZBcmd1bWVudHNBcmVOb3RBbGxDaGVja2VkKFxuICAgICAgZiwgY29udGV4dCwgYXJncywgZGVzY3JpcHRpb24pO1xuICB9XG4gIHJldHVybiBmLmFwcGx5KGNvbnRleHQsIGFyZ3MpO1xufTtcbiIsInZhciBGdXR1cmUgPSBOcG0ucmVxdWlyZSgnZmliZXJzL2Z1dHVyZScpO1xuXG4vLyBBIHdyaXRlIGZlbmNlIGNvbGxlY3RzIGEgZ3JvdXAgb2Ygd3JpdGVzLCBhbmQgcHJvdmlkZXMgYSBjYWxsYmFja1xuLy8gd2hlbiBhbGwgb2YgdGhlIHdyaXRlcyBhcmUgZnVsbHkgY29tbWl0dGVkIGFuZCBwcm9wYWdhdGVkIChhbGxcbi8vIG9ic2VydmVycyBoYXZlIGJlZW4gbm90aWZpZWQgb2YgdGhlIHdyaXRlIGFuZCBhY2tub3dsZWRnZWQgaXQuKVxuLy9cbkREUFNlcnZlci5fV3JpdGVGZW5jZSA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gIHNlbGYuYXJtZWQgPSBmYWxzZTtcbiAgc2VsZi5maXJlZCA9IGZhbHNlO1xuICBzZWxmLnJldGlyZWQgPSBmYWxzZTtcbiAgc2VsZi5vdXRzdGFuZGluZ193cml0ZXMgPSAwO1xuICBzZWxmLmJlZm9yZV9maXJlX2NhbGxiYWNrcyA9IFtdO1xuICBzZWxmLmNvbXBsZXRpb25fY2FsbGJhY2tzID0gW107XG59O1xuXG4vLyBUaGUgY3VycmVudCB3cml0ZSBmZW5jZS4gV2hlbiB0aGVyZSBpcyBhIGN1cnJlbnQgd3JpdGUgZmVuY2UsIGNvZGVcbi8vIHRoYXQgd3JpdGVzIHRvIGRhdGFiYXNlcyBzaG91bGQgcmVnaXN0ZXIgdGhlaXIgd3JpdGVzIHdpdGggaXQgdXNpbmdcbi8vIGJlZ2luV3JpdGUoKS5cbi8vXG5ERFBTZXJ2ZXIuX0N1cnJlbnRXcml0ZUZlbmNlID0gbmV3IE1ldGVvci5FbnZpcm9ubWVudFZhcmlhYmxlO1xuXG5fLmV4dGVuZChERFBTZXJ2ZXIuX1dyaXRlRmVuY2UucHJvdG90eXBlLCB7XG4gIC8vIFN0YXJ0IHRyYWNraW5nIGEgd3JpdGUsIGFuZCByZXR1cm4gYW4gb2JqZWN0IHRvIHJlcHJlc2VudCBpdC4gVGhlXG4gIC8vIG9iamVjdCBoYXMgYSBzaW5nbGUgbWV0aG9kLCBjb21taXR0ZWQoKS4gVGhpcyBtZXRob2Qgc2hvdWxkIGJlXG4gIC8vIGNhbGxlZCB3aGVuIHRoZSB3cml0ZSBpcyBmdWxseSBjb21taXR0ZWQgYW5kIHByb3BhZ2F0ZWQuIFlvdSBjYW5cbiAgLy8gY29udGludWUgdG8gYWRkIHdyaXRlcyB0byB0aGUgV3JpdGVGZW5jZSB1cCB1bnRpbCBpdCBpcyB0cmlnZ2VyZWRcbiAgLy8gKGNhbGxzIGl0cyBjYWxsYmFja3MgYmVjYXVzZSBhbGwgd3JpdGVzIGhhdmUgY29tbWl0dGVkLilcbiAgYmVnaW5Xcml0ZTogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcblxuICAgIGlmIChzZWxmLnJldGlyZWQpXG4gICAgICByZXR1cm4geyBjb21taXR0ZWQ6IGZ1bmN0aW9uICgpIHt9IH07XG5cbiAgICBpZiAoc2VsZi5maXJlZClcbiAgICAgIHRocm93IG5ldyBFcnJvcihcImZlbmNlIGhhcyBhbHJlYWR5IGFjdGl2YXRlZCAtLSB0b28gbGF0ZSB0byBhZGQgd3JpdGVzXCIpO1xuXG4gICAgc2VsZi5vdXRzdGFuZGluZ193cml0ZXMrKztcbiAgICB2YXIgY29tbWl0dGVkID0gZmFsc2U7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbW1pdHRlZDogZnVuY3Rpb24gKCkge1xuICAgICAgICBpZiAoY29tbWl0dGVkKVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcImNvbW1pdHRlZCBjYWxsZWQgdHdpY2Ugb24gdGhlIHNhbWUgd3JpdGVcIik7XG4gICAgICAgIGNvbW1pdHRlZCA9IHRydWU7XG4gICAgICAgIHNlbGYub3V0c3RhbmRpbmdfd3JpdGVzLS07XG4gICAgICAgIHNlbGYuX21heWJlRmlyZSgpO1xuICAgICAgfVxuICAgIH07XG4gIH0sXG5cbiAgLy8gQXJtIHRoZSBmZW5jZS4gT25jZSB0aGUgZmVuY2UgaXMgYXJtZWQsIGFuZCB0aGVyZSBhcmUgbm8gbW9yZVxuICAvLyB1bmNvbW1pdHRlZCB3cml0ZXMsIGl0IHdpbGwgYWN0aXZhdGUuXG4gIGFybTogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoc2VsZiA9PT0gRERQU2VydmVyLl9DdXJyZW50V3JpdGVGZW5jZS5nZXQoKSlcbiAgICAgIHRocm93IEVycm9yKFwiQ2FuJ3QgYXJtIHRoZSBjdXJyZW50IGZlbmNlXCIpO1xuICAgIHNlbGYuYXJtZWQgPSB0cnVlO1xuICAgIHNlbGYuX21heWJlRmlyZSgpO1xuICB9LFxuXG4gIC8vIFJlZ2lzdGVyIGEgZnVuY3Rpb24gdG8gYmUgY2FsbGVkIG9uY2UgYmVmb3JlIGZpcmluZyB0aGUgZmVuY2UuXG4gIC8vIENhbGxiYWNrIGZ1bmN0aW9uIGNhbiBhZGQgbmV3IHdyaXRlcyB0byB0aGUgZmVuY2UsIGluIHdoaWNoIGNhc2VcbiAgLy8gaXQgd29uJ3QgZmlyZSB1bnRpbCB0aG9zZSB3cml0ZXMgYXJlIGRvbmUgYXMgd2VsbC5cbiAgb25CZWZvcmVGaXJlOiBmdW5jdGlvbiAoZnVuYykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoc2VsZi5maXJlZClcbiAgICAgIHRocm93IG5ldyBFcnJvcihcImZlbmNlIGhhcyBhbHJlYWR5IGFjdGl2YXRlZCAtLSB0b28gbGF0ZSB0byBcIiArXG4gICAgICAgICAgICAgICAgICAgICAgXCJhZGQgYSBjYWxsYmFja1wiKTtcbiAgICBzZWxmLmJlZm9yZV9maXJlX2NhbGxiYWNrcy5wdXNoKGZ1bmMpO1xuICB9LFxuXG4gIC8vIFJlZ2lzdGVyIGEgZnVuY3Rpb24gdG8gYmUgY2FsbGVkIHdoZW4gdGhlIGZlbmNlIGZpcmVzLlxuICBvbkFsbENvbW1pdHRlZDogZnVuY3Rpb24gKGZ1bmMpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKHNlbGYuZmlyZWQpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJmZW5jZSBoYXMgYWxyZWFkeSBhY3RpdmF0ZWQgLS0gdG9vIGxhdGUgdG8gXCIgK1xuICAgICAgICAgICAgICAgICAgICAgIFwiYWRkIGEgY2FsbGJhY2tcIik7XG4gICAgc2VsZi5jb21wbGV0aW9uX2NhbGxiYWNrcy5wdXNoKGZ1bmMpO1xuICB9LFxuXG4gIC8vIENvbnZlbmllbmNlIGZ1bmN0aW9uLiBBcm1zIHRoZSBmZW5jZSwgdGhlbiBibG9ja3MgdW50aWwgaXQgZmlyZXMuXG4gIGFybUFuZFdhaXQ6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgdmFyIGZ1dHVyZSA9IG5ldyBGdXR1cmU7XG4gICAgc2VsZi5vbkFsbENvbW1pdHRlZChmdW5jdGlvbiAoKSB7XG4gICAgICBmdXR1cmVbJ3JldHVybiddKCk7XG4gICAgfSk7XG4gICAgc2VsZi5hcm0oKTtcbiAgICBmdXR1cmUud2FpdCgpO1xuICB9LFxuXG4gIF9tYXliZUZpcmU6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKHNlbGYuZmlyZWQpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJ3cml0ZSBmZW5jZSBhbHJlYWR5IGFjdGl2YXRlZD9cIik7XG4gICAgaWYgKHNlbGYuYXJtZWQgJiYgIXNlbGYub3V0c3RhbmRpbmdfd3JpdGVzKSB7XG4gICAgICBmdW5jdGlvbiBpbnZva2VDYWxsYmFjayAoZnVuYykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGZ1bmMoc2VsZik7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIE1ldGVvci5fZGVidWcoXCJleGNlcHRpb24gaW4gd3JpdGUgZmVuY2UgY2FsbGJhY2tcIiwgZXJyKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBzZWxmLm91dHN0YW5kaW5nX3dyaXRlcysrO1xuICAgICAgd2hpbGUgKHNlbGYuYmVmb3JlX2ZpcmVfY2FsbGJhY2tzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgdmFyIGNhbGxiYWNrcyA9IHNlbGYuYmVmb3JlX2ZpcmVfY2FsbGJhY2tzO1xuICAgICAgICBzZWxmLmJlZm9yZV9maXJlX2NhbGxiYWNrcyA9IFtdO1xuICAgICAgICBfLmVhY2goY2FsbGJhY2tzLCBpbnZva2VDYWxsYmFjayk7XG4gICAgICB9XG4gICAgICBzZWxmLm91dHN0YW5kaW5nX3dyaXRlcy0tO1xuXG4gICAgICBpZiAoIXNlbGYub3V0c3RhbmRpbmdfd3JpdGVzKSB7XG4gICAgICAgIHNlbGYuZmlyZWQgPSB0cnVlO1xuICAgICAgICB2YXIgY2FsbGJhY2tzID0gc2VsZi5jb21wbGV0aW9uX2NhbGxiYWNrcztcbiAgICAgICAgc2VsZi5jb21wbGV0aW9uX2NhbGxiYWNrcyA9IFtdO1xuICAgICAgICBfLmVhY2goY2FsbGJhY2tzLCBpbnZva2VDYWxsYmFjayk7XG4gICAgICB9XG4gICAgfVxuICB9LFxuXG4gIC8vIERlYWN0aXZhdGUgdGhpcyBmZW5jZSBzbyB0aGF0IGFkZGluZyBtb3JlIHdyaXRlcyBoYXMgbm8gZWZmZWN0LlxuICAvLyBUaGUgZmVuY2UgbXVzdCBoYXZlIGFscmVhZHkgZmlyZWQuXG4gIHJldGlyZTogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoISBzZWxmLmZpcmVkKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQ2FuJ3QgcmV0aXJlIGEgZmVuY2UgdGhhdCBoYXNuJ3QgZmlyZWQuXCIpO1xuICAgIHNlbGYucmV0aXJlZCA9IHRydWU7XG4gIH1cbn0pO1xuIiwiLy8gQSBcImNyb3NzYmFyXCIgaXMgYSBjbGFzcyB0aGF0IHByb3ZpZGVzIHN0cnVjdHVyZWQgbm90aWZpY2F0aW9uIHJlZ2lzdHJhdGlvbi5cbi8vIFNlZSBfbWF0Y2ggZm9yIHRoZSBkZWZpbml0aW9uIG9mIGhvdyBhIG5vdGlmaWNhdGlvbiBtYXRjaGVzIGEgdHJpZ2dlci5cbi8vIEFsbCBub3RpZmljYXRpb25zIGFuZCB0cmlnZ2VycyBtdXN0IGhhdmUgYSBzdHJpbmcga2V5IG5hbWVkICdjb2xsZWN0aW9uJy5cblxuRERQU2VydmVyLl9Dcm9zc2JhciA9IGZ1bmN0aW9uIChvcHRpb25zKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG5cbiAgc2VsZi5uZXh0SWQgPSAxO1xuICAvLyBtYXAgZnJvbSBjb2xsZWN0aW9uIG5hbWUgKHN0cmluZykgLT4gbGlzdGVuZXIgaWQgLT4gb2JqZWN0LiBlYWNoIG9iamVjdCBoYXNcbiAgLy8ga2V5cyAndHJpZ2dlcicsICdjYWxsYmFjaycuICBBcyBhIGhhY2ssIHRoZSBlbXB0eSBzdHJpbmcgbWVhbnMgXCJub1xuICAvLyBjb2xsZWN0aW9uXCIuXG4gIHNlbGYubGlzdGVuZXJzQnlDb2xsZWN0aW9uID0ge307XG4gIHNlbGYubGlzdGVuZXJzQnlDb2xsZWN0aW9uQ291bnQgPSB7fTtcbiAgc2VsZi5mYWN0UGFja2FnZSA9IG9wdGlvbnMuZmFjdFBhY2thZ2UgfHwgXCJsaXZlZGF0YVwiO1xuICBzZWxmLmZhY3ROYW1lID0gb3B0aW9ucy5mYWN0TmFtZSB8fCBudWxsO1xufTtcblxuXy5leHRlbmQoRERQU2VydmVyLl9Dcm9zc2Jhci5wcm90b3R5cGUsIHtcbiAgLy8gbXNnIGlzIGEgdHJpZ2dlciBvciBhIG5vdGlmaWNhdGlvblxuICBfY29sbGVjdGlvbkZvck1lc3NhZ2U6IGZ1bmN0aW9uIChtc2cpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKCEgXy5oYXMobXNnLCAnY29sbGVjdGlvbicpKSB7XG4gICAgICByZXR1cm4gJyc7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YobXNnLmNvbGxlY3Rpb24pID09PSAnc3RyaW5nJykge1xuICAgICAgaWYgKG1zZy5jb2xsZWN0aW9uID09PSAnJylcbiAgICAgICAgdGhyb3cgRXJyb3IoXCJNZXNzYWdlIGhhcyBlbXB0eSBjb2xsZWN0aW9uIVwiKTtcbiAgICAgIHJldHVybiBtc2cuY29sbGVjdGlvbjtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgRXJyb3IoXCJNZXNzYWdlIGhhcyBub24tc3RyaW5nIGNvbGxlY3Rpb24hXCIpO1xuICAgIH1cbiAgfSxcblxuICAvLyBMaXN0ZW4gZm9yIG5vdGlmaWNhdGlvbiB0aGF0IG1hdGNoICd0cmlnZ2VyJy4gQSBub3RpZmljYXRpb25cbiAgLy8gbWF0Y2hlcyBpZiBpdCBoYXMgdGhlIGtleS12YWx1ZSBwYWlycyBpbiB0cmlnZ2VyIGFzIGFcbiAgLy8gc3Vic2V0LiBXaGVuIGEgbm90aWZpY2F0aW9uIG1hdGNoZXMsIGNhbGwgJ2NhbGxiYWNrJywgcGFzc2luZ1xuICAvLyB0aGUgYWN0dWFsIG5vdGlmaWNhdGlvbi5cbiAgLy9cbiAgLy8gUmV0dXJucyBhIGxpc3RlbiBoYW5kbGUsIHdoaWNoIGlzIGFuIG9iamVjdCB3aXRoIGEgbWV0aG9kXG4gIC8vIHN0b3AoKS4gQ2FsbCBzdG9wKCkgdG8gc3RvcCBsaXN0ZW5pbmcuXG4gIC8vXG4gIC8vIFhYWCBJdCBzaG91bGQgYmUgbGVnYWwgdG8gY2FsbCBmaXJlKCkgZnJvbSBpbnNpZGUgYSBsaXN0ZW4oKVxuICAvLyBjYWxsYmFjaz9cbiAgbGlzdGVuOiBmdW5jdGlvbiAodHJpZ2dlciwgY2FsbGJhY2spIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgdmFyIGlkID0gc2VsZi5uZXh0SWQrKztcblxuICAgIHZhciBjb2xsZWN0aW9uID0gc2VsZi5fY29sbGVjdGlvbkZvck1lc3NhZ2UodHJpZ2dlcik7XG4gICAgdmFyIHJlY29yZCA9IHt0cmlnZ2VyOiBFSlNPTi5jbG9uZSh0cmlnZ2VyKSwgY2FsbGJhY2s6IGNhbGxiYWNrfTtcbiAgICBpZiAoISBfLmhhcyhzZWxmLmxpc3RlbmVyc0J5Q29sbGVjdGlvbiwgY29sbGVjdGlvbikpIHtcbiAgICAgIHNlbGYubGlzdGVuZXJzQnlDb2xsZWN0aW9uW2NvbGxlY3Rpb25dID0ge307XG4gICAgICBzZWxmLmxpc3RlbmVyc0J5Q29sbGVjdGlvbkNvdW50W2NvbGxlY3Rpb25dID0gMDtcbiAgICB9XG4gICAgc2VsZi5saXN0ZW5lcnNCeUNvbGxlY3Rpb25bY29sbGVjdGlvbl1baWRdID0gcmVjb3JkO1xuICAgIHNlbGYubGlzdGVuZXJzQnlDb2xsZWN0aW9uQ291bnRbY29sbGVjdGlvbl0rKztcblxuICAgIGlmIChzZWxmLmZhY3ROYW1lICYmIFBhY2thZ2VbJ2ZhY3RzLWJhc2UnXSkge1xuICAgICAgUGFja2FnZVsnZmFjdHMtYmFzZSddLkZhY3RzLmluY3JlbWVudFNlcnZlckZhY3QoXG4gICAgICAgIHNlbGYuZmFjdFBhY2thZ2UsIHNlbGYuZmFjdE5hbWUsIDEpO1xuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICBzdG9wOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIGlmIChzZWxmLmZhY3ROYW1lICYmIFBhY2thZ2VbJ2ZhY3RzLWJhc2UnXSkge1xuICAgICAgICAgIFBhY2thZ2VbJ2ZhY3RzLWJhc2UnXS5GYWN0cy5pbmNyZW1lbnRTZXJ2ZXJGYWN0KFxuICAgICAgICAgICAgc2VsZi5mYWN0UGFja2FnZSwgc2VsZi5mYWN0TmFtZSwgLTEpO1xuICAgICAgICB9XG4gICAgICAgIGRlbGV0ZSBzZWxmLmxpc3RlbmVyc0J5Q29sbGVjdGlvbltjb2xsZWN0aW9uXVtpZF07XG4gICAgICAgIHNlbGYubGlzdGVuZXJzQnlDb2xsZWN0aW9uQ291bnRbY29sbGVjdGlvbl0tLTtcbiAgICAgICAgaWYgKHNlbGYubGlzdGVuZXJzQnlDb2xsZWN0aW9uQ291bnRbY29sbGVjdGlvbl0gPT09IDApIHtcbiAgICAgICAgICBkZWxldGUgc2VsZi5saXN0ZW5lcnNCeUNvbGxlY3Rpb25bY29sbGVjdGlvbl07XG4gICAgICAgICAgZGVsZXRlIHNlbGYubGlzdGVuZXJzQnlDb2xsZWN0aW9uQ291bnRbY29sbGVjdGlvbl07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9O1xuICB9LFxuXG4gIC8vIEZpcmUgdGhlIHByb3ZpZGVkICdub3RpZmljYXRpb24nIChhbiBvYmplY3Qgd2hvc2UgYXR0cmlidXRlXG4gIC8vIHZhbHVlcyBhcmUgYWxsIEpTT04tY29tcGF0aWJpbGUpIC0tIGluZm9ybSBhbGwgbWF0Y2hpbmcgbGlzdGVuZXJzXG4gIC8vIChyZWdpc3RlcmVkIHdpdGggbGlzdGVuKCkpLlxuICAvL1xuICAvLyBJZiBmaXJlKCkgaXMgY2FsbGVkIGluc2lkZSBhIHdyaXRlIGZlbmNlLCB0aGVuIGVhY2ggb2YgdGhlXG4gIC8vIGxpc3RlbmVyIGNhbGxiYWNrcyB3aWxsIGJlIGNhbGxlZCBpbnNpZGUgdGhlIHdyaXRlIGZlbmNlIGFzIHdlbGwuXG4gIC8vXG4gIC8vIFRoZSBsaXN0ZW5lcnMgbWF5IGJlIGludm9rZWQgaW4gcGFyYWxsZWwsIHJhdGhlciB0aGFuIHNlcmlhbGx5LlxuICBmaXJlOiBmdW5jdGlvbiAobm90aWZpY2F0aW9uKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gICAgdmFyIGNvbGxlY3Rpb24gPSBzZWxmLl9jb2xsZWN0aW9uRm9yTWVzc2FnZShub3RpZmljYXRpb24pO1xuXG4gICAgaWYgKCEgXy5oYXMoc2VsZi5saXN0ZW5lcnNCeUNvbGxlY3Rpb24sIGNvbGxlY3Rpb24pKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgdmFyIGxpc3RlbmVyc0ZvckNvbGxlY3Rpb24gPSBzZWxmLmxpc3RlbmVyc0J5Q29sbGVjdGlvbltjb2xsZWN0aW9uXTtcbiAgICB2YXIgY2FsbGJhY2tJZHMgPSBbXTtcbiAgICBfLmVhY2gobGlzdGVuZXJzRm9yQ29sbGVjdGlvbiwgZnVuY3Rpb24gKGwsIGlkKSB7XG4gICAgICBpZiAoc2VsZi5fbWF0Y2hlcyhub3RpZmljYXRpb24sIGwudHJpZ2dlcikpIHtcbiAgICAgICAgY2FsbGJhY2tJZHMucHVzaChpZCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICAvLyBMaXN0ZW5lciBjYWxsYmFja3MgY2FuIHlpZWxkLCBzbyB3ZSBuZWVkIHRvIGZpcnN0IGZpbmQgYWxsIHRoZSBvbmVzIHRoYXRcbiAgICAvLyBtYXRjaCBpbiBhIHNpbmdsZSBpdGVyYXRpb24gb3ZlciBzZWxmLmxpc3RlbmVyc0J5Q29sbGVjdGlvbiAod2hpY2ggY2FuJ3RcbiAgICAvLyBiZSBtdXRhdGVkIGR1cmluZyB0aGlzIGl0ZXJhdGlvbiksIGFuZCB0aGVuIGludm9rZSB0aGUgbWF0Y2hpbmdcbiAgICAvLyBjYWxsYmFja3MsIGNoZWNraW5nIGJlZm9yZSBlYWNoIGNhbGwgdG8gZW5zdXJlIHRoZXkgaGF2ZW4ndCBzdG9wcGVkLlxuICAgIC8vIE5vdGUgdGhhdCB3ZSBkb24ndCBoYXZlIHRvIGNoZWNrIHRoYXRcbiAgICAvLyBzZWxmLmxpc3RlbmVyc0J5Q29sbGVjdGlvbltjb2xsZWN0aW9uXSBzdGlsbCA9PT0gbGlzdGVuZXJzRm9yQ29sbGVjdGlvbixcbiAgICAvLyBiZWNhdXNlIHRoZSBvbmx5IHdheSB0aGF0IHN0b3BzIGJlaW5nIHRydWUgaXMgaWYgbGlzdGVuZXJzRm9yQ29sbGVjdGlvblxuICAgIC8vIGZpcnN0IGdldHMgcmVkdWNlZCBkb3duIHRvIHRoZSBlbXB0eSBvYmplY3QgKGFuZCB0aGVuIG5ldmVyIGdldHNcbiAgICAvLyBpbmNyZWFzZWQgYWdhaW4pLlxuICAgIF8uZWFjaChjYWxsYmFja0lkcywgZnVuY3Rpb24gKGlkKSB7XG4gICAgICBpZiAoXy5oYXMobGlzdGVuZXJzRm9yQ29sbGVjdGlvbiwgaWQpKSB7XG4gICAgICAgIGxpc3RlbmVyc0ZvckNvbGxlY3Rpb25baWRdLmNhbGxiYWNrKG5vdGlmaWNhdGlvbik7XG4gICAgICB9XG4gICAgfSk7XG4gIH0sXG5cbiAgLy8gQSBub3RpZmljYXRpb24gbWF0Y2hlcyBhIHRyaWdnZXIgaWYgYWxsIGtleXMgdGhhdCBleGlzdCBpbiBib3RoIGFyZSBlcXVhbC5cbiAgLy9cbiAgLy8gRXhhbXBsZXM6XG4gIC8vICBOOntjb2xsZWN0aW9uOiBcIkNcIn0gbWF0Y2hlcyBUOntjb2xsZWN0aW9uOiBcIkNcIn1cbiAgLy8gICAgKGEgbm9uLXRhcmdldGVkIHdyaXRlIHRvIGEgY29sbGVjdGlvbiBtYXRjaGVzIGFcbiAgLy8gICAgIG5vbi10YXJnZXRlZCBxdWVyeSlcbiAgLy8gIE46e2NvbGxlY3Rpb246IFwiQ1wiLCBpZDogXCJYXCJ9IG1hdGNoZXMgVDp7Y29sbGVjdGlvbjogXCJDXCJ9XG4gIC8vICAgIChhIHRhcmdldGVkIHdyaXRlIHRvIGEgY29sbGVjdGlvbiBtYXRjaGVzIGEgbm9uLXRhcmdldGVkIHF1ZXJ5KVxuICAvLyAgTjp7Y29sbGVjdGlvbjogXCJDXCJ9IG1hdGNoZXMgVDp7Y29sbGVjdGlvbjogXCJDXCIsIGlkOiBcIlhcIn1cbiAgLy8gICAgKGEgbm9uLXRhcmdldGVkIHdyaXRlIHRvIGEgY29sbGVjdGlvbiBtYXRjaGVzIGFcbiAgLy8gICAgIHRhcmdldGVkIHF1ZXJ5KVxuICAvLyAgTjp7Y29sbGVjdGlvbjogXCJDXCIsIGlkOiBcIlhcIn0gbWF0Y2hlcyBUOntjb2xsZWN0aW9uOiBcIkNcIiwgaWQ6IFwiWFwifVxuICAvLyAgICAoYSB0YXJnZXRlZCB3cml0ZSB0byBhIGNvbGxlY3Rpb24gbWF0Y2hlcyBhIHRhcmdldGVkIHF1ZXJ5IHRhcmdldGVkXG4gIC8vICAgICBhdCB0aGUgc2FtZSBkb2N1bWVudClcbiAgLy8gIE46e2NvbGxlY3Rpb246IFwiQ1wiLCBpZDogXCJYXCJ9IGRvZXMgbm90IG1hdGNoIFQ6e2NvbGxlY3Rpb246IFwiQ1wiLCBpZDogXCJZXCJ9XG4gIC8vICAgIChhIHRhcmdldGVkIHdyaXRlIHRvIGEgY29sbGVjdGlvbiBkb2VzIG5vdCBtYXRjaCBhIHRhcmdldGVkIHF1ZXJ5XG4gIC8vICAgICB0YXJnZXRlZCBhdCBhIGRpZmZlcmVudCBkb2N1bWVudClcbiAgX21hdGNoZXM6IGZ1bmN0aW9uIChub3RpZmljYXRpb24sIHRyaWdnZXIpIHtcbiAgICAvLyBNb3N0IG5vdGlmaWNhdGlvbnMgdGhhdCB1c2UgdGhlIGNyb3NzYmFyIGhhdmUgYSBzdHJpbmcgYGNvbGxlY3Rpb25gIGFuZFxuICAgIC8vIG1heWJlIGFuIGBpZGAgdGhhdCBpcyBhIHN0cmluZyBvciBPYmplY3RJRC4gV2UncmUgYWxyZWFkeSBkaXZpZGluZyB1cFxuICAgIC8vIHRyaWdnZXJzIGJ5IGNvbGxlY3Rpb24sIGJ1dCBsZXQncyBmYXN0LXRyYWNrIFwibm9wZSwgZGlmZmVyZW50IElEXCIgKGFuZFxuICAgIC8vIGF2b2lkIHRoZSBvdmVybHkgZ2VuZXJpYyBFSlNPTi5lcXVhbHMpLiBUaGlzIG1ha2VzIGEgbm90aWNlYWJsZVxuICAgIC8vIHBlcmZvcm1hbmNlIGRpZmZlcmVuY2U7IHNlZSBodHRwczovL2dpdGh1Yi5jb20vbWV0ZW9yL21ldGVvci9wdWxsLzM2OTdcbiAgICBpZiAodHlwZW9mKG5vdGlmaWNhdGlvbi5pZCkgPT09ICdzdHJpbmcnICYmXG4gICAgICAgIHR5cGVvZih0cmlnZ2VyLmlkKSA9PT0gJ3N0cmluZycgJiZcbiAgICAgICAgbm90aWZpY2F0aW9uLmlkICE9PSB0cmlnZ2VyLmlkKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGlmIChub3RpZmljYXRpb24uaWQgaW5zdGFuY2VvZiBNb25nb0lELk9iamVjdElEICYmXG4gICAgICAgIHRyaWdnZXIuaWQgaW5zdGFuY2VvZiBNb25nb0lELk9iamVjdElEICYmXG4gICAgICAgICEgbm90aWZpY2F0aW9uLmlkLmVxdWFscyh0cmlnZ2VyLmlkKSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIHJldHVybiBfLmFsbCh0cmlnZ2VyLCBmdW5jdGlvbiAodHJpZ2dlclZhbHVlLCBrZXkpIHtcbiAgICAgIHJldHVybiAhXy5oYXMobm90aWZpY2F0aW9uLCBrZXkpIHx8XG4gICAgICAgIEVKU09OLmVxdWFscyh0cmlnZ2VyVmFsdWUsIG5vdGlmaWNhdGlvbltrZXldKTtcbiAgICB9KTtcbiAgfVxufSk7XG5cbi8vIFRoZSBcImludmFsaWRhdGlvbiBjcm9zc2JhclwiIGlzIGEgc3BlY2lmaWMgaW5zdGFuY2UgdXNlZCBieSB0aGUgRERQIHNlcnZlciB0b1xuLy8gaW1wbGVtZW50IHdyaXRlIGZlbmNlIG5vdGlmaWNhdGlvbnMuIExpc3RlbmVyIGNhbGxiYWNrcyBvbiB0aGlzIGNyb3NzYmFyXG4vLyBzaG91bGQgY2FsbCBiZWdpbldyaXRlIG9uIHRoZSBjdXJyZW50IHdyaXRlIGZlbmNlIGJlZm9yZSB0aGV5IHJldHVybiwgaWYgdGhleVxuLy8gd2FudCB0byBkZWxheSB0aGUgd3JpdGUgZmVuY2UgZnJvbSBmaXJpbmcgKGllLCB0aGUgRERQIG1ldGhvZC1kYXRhLXVwZGF0ZWRcbi8vIG1lc3NhZ2UgZnJvbSBiZWluZyBzZW50KS5cbkREUFNlcnZlci5fSW52YWxpZGF0aW9uQ3Jvc3NiYXIgPSBuZXcgRERQU2VydmVyLl9Dcm9zc2Jhcih7XG4gIGZhY3ROYW1lOiBcImludmFsaWRhdGlvbi1jcm9zc2Jhci1saXN0ZW5lcnNcIlxufSk7XG4iLCJpZiAocHJvY2Vzcy5lbnYuRERQX0RFRkFVTFRfQ09OTkVDVElPTl9VUkwpIHtcbiAgX19tZXRlb3JfcnVudGltZV9jb25maWdfXy5ERFBfREVGQVVMVF9DT05ORUNUSU9OX1VSTCA9XG4gICAgcHJvY2Vzcy5lbnYuRERQX0RFRkFVTFRfQ09OTkVDVElPTl9VUkw7XG59XG5cbk1ldGVvci5zZXJ2ZXIgPSBuZXcgU2VydmVyO1xuXG5NZXRlb3IucmVmcmVzaCA9IGZ1bmN0aW9uIChub3RpZmljYXRpb24pIHtcbiAgRERQU2VydmVyLl9JbnZhbGlkYXRpb25Dcm9zc2Jhci5maXJlKG5vdGlmaWNhdGlvbik7XG59O1xuXG4vLyBQcm94eSB0aGUgcHVibGljIG1ldGhvZHMgb2YgTWV0ZW9yLnNlcnZlciBzbyB0aGV5IGNhblxuLy8gYmUgY2FsbGVkIGRpcmVjdGx5IG9uIE1ldGVvci5cbl8uZWFjaChcbiAgW1xuICAgICdwdWJsaXNoJyxcbiAgICAnbWV0aG9kcycsXG4gICAgJ2NhbGwnLFxuICAgICdjYWxsQXN5bmMnLFxuICAgICdhcHBseScsXG4gICAgJ2FwcGx5QXN5bmMnLFxuICAgICdvbkNvbm5lY3Rpb24nLFxuICAgICdvbk1lc3NhZ2UnLFxuICBdLFxuICBmdW5jdGlvbihuYW1lKSB7XG4gICAgTWV0ZW9yW25hbWVdID0gXy5iaW5kKE1ldGVvci5zZXJ2ZXJbbmFtZV0sIE1ldGVvci5zZXJ2ZXIpO1xuICB9XG4pO1xuIl19
