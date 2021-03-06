/**
 *
 * ©2016-2017 EdgeVerve Systems Limited (a fully owned Infosys subsidiary),
 * Bangalore, India. All Rights Reserved.
 *
 */
/* eslint-disable no-console, no-loop-func */
var nodeRed = require('loopback-connector-nodes-for-Node-RED');
var loopback = require('loopback');
var _ = require('lodash');
var messaging = require('../../lib/common/global-messaging');
var uuid = require('node-uuid');


// Atul : this function returns value of autoscope fields as concatination string.
// This should been made as utility function and should not tied to node-red in general.
// file name is changed to zzz-node-red.js to ensure that node-red is started after all data is loaded. needs to think better to avoid this kind of fix
function getAutoscopeField(model, callContext) {
  var field = model.modelName;
  if (model.settings && model.settings.autoscope && model.settings.autoscope.length > 0) {
    for (var i = 0; i < model.settings.autoscope.length; ++i) {
      var f = model.settings.autoscope[i];
      field += '-' + callContext.ctx[f];
    }
  }
  return field;
}

module.exports = function startNodeRed(server, callback) {
  if (server.get('disableNodered') === true) {
    console.log('\n===================================================================\n');
    console.log('INFO: Node-Red is disabled via config.json: (disableNodered: true)');
    console.log('\n===================================================================\n');

    return callback();
  }
  var nodeRedPort = server.get('nodeRedPort');
  var port = nodeRedPort ? nodeRedPort : 3001;
  var nodeRedUserDir = server.get('nodeRedUserDir');
  if (!nodeRedUserDir) {
    nodeRedUserDir = 'nodered/';
  }
  var settings = {
    httpAdminRoot: '/red',
    httpNodeRoot: '/redapi',
    userDir: nodeRedUserDir,
    nodesDir: '../nodes',
    flowFile: 'node-red-flows.json',
    server: server,
    flowFilePretty: true,
    functionGlobalContext: {
      loopback: require('loopback'),
      logger: require('../../lib/logger')('node-red-flow')
    }
    // enables global context
  };
  var clientGlobalContext = server.get('nodeRedGlobalContext');
  if (clientGlobalContext) {
    var keys = Object.keys(clientGlobalContext);
    var globalContext = settings.functionGlobalContext;
    keys.forEach(function addToGlobalContext(key) {
      if (clientGlobalContext[key]) {
        globalContext[key] = require(clientGlobalContext[key]);
      }
    });
  }


  var app = settings.server;
  var RED = nodeRed.RED;
  var redNodes = RED.nodes;
  var originalCreateNode = redNodes.createNode;
  var flagOnce = true;
  redNodes.createNode = function createNodes(node, def) {
    originalCreateNode(node, def);
    node.callContext = def.callContext;
    if (flagOnce) {
      flagOnce = false;
      node.constructor.super_.prototype._receive = node.constructor.super_.prototype.receive;
      node.constructor.super_.prototype.receive = function receiveFn(msg) {
        if (!msg) {
          msg = {};
        }
        msg.callback = this.callContext;
        this._receive(msg);
      };
      node.constructor.super_.prototype._on_ = node.constructor.super_.prototype._on;
      node.constructor.super_.prototype._on = function onEventHandlerFn(event, callback) {
        return this._on_(event, function onEventCb(msg) {
          if (!msg) {
            msg = {};
          }
          msg.callContext = this.callContext;
          callback.call(this, msg);
        });
      };
    }
  };
  var flowModel = loopback.findModel('NodeRedFlow');
  flowModel.observe('after save', function flowModelAfterSave(ctx, next) {
    // Calling reload() directly in addition to message publish
    // as self messages are disabled by default
    // Need to fix duplicate reloading when a 'deploy' is done from Node-Red UI

    messaging.publish('reloadNodeRedFlows', uuid.v4());
    reload(redNodes, function reloadNodes() { });

    next();
  });

  if (server.get('useDefaultNodeRedStorage')) {
    nodeRed.start({
      port: port,
      settings: settings
    }, function applicationCallback() {
      return callback();
    });
    return;
  }

  // Rakesh : body-parser is used as req.body is getting lost
  var bodyParser = require('body-parser');
  // 1mb limit is used to avoid request entity too large exception
  var jsonremoting = {
    limit: '1mb'
  };
  var urlencoded = {
    limit: '1mb'
  };
  if (app.get('remoting') && app.get('remoting').json) {
    jsonremoting = app.get('remoting').json;
  }
  if (app.get('remoting') && app.get('remoting').urlencoded) {
    urlencoded = app.get('remoting').urlencoded;
  }
  app.use(bodyParser.json(jsonremoting));
  app.use(bodyParser.urlencoded(urlencoded));
  var storageModule = require('../../lib/db-storage-for-node-red.js');
  settings.storageModule = storageModule;
  // Atul : this REST end point is used to get credentials. it will query NodeRedFlow model and return credential information for the node
  // Since it uses context, credentials for requested nodes belong to current context will be returned.
  // if field type of 'password' it will return it as 'has_password'
  app.get(settings.httpAdminRoot + '/credentials/:nodeType/:nodeId', function getHttpAdminRoot(req, res) {
    if (!req.accessToken) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    var nodeId = req.params.nodeId;
    var nodeType = req.params.nodeType;
    if (!nodeId || !nodeType) {
      return res.json({});
    }
    var flowArray = [];
    var autoscopeField = getAutoscopeField(flowModel, req.callContext);
    flowModel.find({ where: { name: autoscopeField } }, req.callContext, function flowModelFindCb(err, results) {
      if (err) {
        return res.status(500).json({ error: 'Internal server error', message: 'no flow found' });
      }
      results.forEach(function forEachResult(r) {
        r.flow.forEach(function prepareFlowArray(f) {
          flowArray.push(f);
        });
      });

      for (var i = 0; i < flowArray.length; ++i) {
        if (flowArray[i].id === nodeId && flowArray[i].type === nodeType) {
          if (!flowArray[i].credentials) {
            return res.json({});
          }
          var definition = redNodes.getCredentialDefinition(nodeType);
          var sendCredentials = {};
          for (var cred in definition) {
            if (definition.hasOwnProperty(cred)) {
              if (definition[cred].type === 'password') {
                var key = 'has_' + cred;
                sendCredentials[key] = flowArray[i].credentials[cred] !== null && flowArray[i].credentials[cred] !== '';
                continue;
              }
              sendCredentials[cred] = flowArray[i].credentials[cred] || '';
            }
          }
          return res.json(sendCredentials);
        }
      }
      return res.json({});
    });
  });

  // Dipayan: disabling file import into the flows. exported file would be used only for migration, using DB migration process
  app.get(settings.httpAdminRoot + '/library/flows', function getFlowsArrayCb(req, res) {
    // return res.json(redNodes.getFlows());
    var flowArray = { 'f': ['Import from file is disabled.'] };
    return res.json(flowArray);
  });

  // Dipayan: disabling file import into the flows. exported file would be used only for migration, using DB migration process
  app.get(settings.httpAdminRoot + '/library/flows/*', function getFlowsArrayCb(req, res) {
    // return res.json(redNodes.getFlows());
    return res.status(403).json({ error: 'Import from file is disabled.' });
  });
  // Atul/Ori : Handle GET /red/flows request here. This will go to loopback model and gets the flow and return same to client.
  // this will bypass default api handling of node-red. This will ensure context specific data to be given to client.
  app.get(settings.httpAdminRoot + '/flows', function getFlowsCb(req, res) {
    if (!req.accessToken) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    // return res.json(redNodes.getFlows());
    var flowArray = [];
    var autoscopeField = getAutoscopeField(flowModel, req.callContext);
    flowModel.find({ where: { name: autoscopeField } }, req.callContext, function flowModelFind(err, results) {
      if (err) {
        return res.status(500).json({ error: 'Internal server error', message: 'No nodered flows found' });
      }
      results.forEach(function resultsForEach(r) {
        r.flow.forEach(function prepareFlowsArray(f) {
          flowArray.push(f);
        });
      });
      if (results.length > 0) {
        res.cookie('_version', results[0]._version, { httpOnly: true, secure: (process.env.PROTOCOL && process.env.PROTOCOL === 'https' ? true : false) });
      }
      return res.json(flowArray);
    });
  });
  // Atul/Ori : Handle POST /red/flows request here. It will store flows posted by client to database
  // this will bypass default api handling of node-red. This will ensure context specific data is stored.
  // It does following in order
  // 1. get all flows for the context (eg current tenant if autoscope is tenant )
  // 2. if flows are present then saves id and version field. Also stores existing flows (actually nodes) into flowArry collection
  // 3. Retrieves all nodes which are active with node-red by calling redNodes.getFlow()
  // 4. It create new entry into allflows or update existing entry based on id and type field of node
  // 5. Calculate entries to be removed
  // 6. Thus create allflows collection that needs to be updated to node-red by calling setNodes()
  // 7. call upsert operation for tenant record.
  // TODO : since flow id generated at client, this can potentially modify flow of other tenant.
  // TODO : it stops and start flow. Need to figure out a way so that not all flows stops. There is logic at node red to find delta. this needs to be visited
  // TODO : Need to work on credential and other storage
  // TODO : Code cleanup
  // TODO : handlign all the end points. Right now only /flows end point is being handled.
  // TODO : Along with authentication, authorization should also be implemented.
  // TODO : Data Personalization mixin change : Right now tenant can modify default tenant data. This should have been prevented. To solve this problem, flow name is concatination of all autoscope fields
  app.post(settings.httpAdminRoot + '/flows', function postFlowsCb(req, res) {
    if (!req.accessToken) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    var reqFlows = req.body;
    var deploymentType = req.get('Node-RED-Deployment-Type') || 'full';

    if (deploymentType === 'reload') {
      return res.status(404).json({ error: 'Invalid Node-RED-Deployment-Type in header', message: 'Node-RED-Deployment-Type \'reload\' is not supported for HTTP POST.' });
    }
    var autoscopeField = getAutoscopeField(flowModel, req.callContext);

    var nodesToRemove = [];
    var dbFlows = [];
    var allflows = redNodes.getFlows();
    flowModel.find({ where: { name: autoscopeField } }, req.callContext, function findCb(err, results) {
      if (err) {
        return res.status(500).json({ error: 'Internal server error', message: 'flow not found.' });
      }
      if (results.length > 1) {
        return res.status(500).json({ error: 'Internal server error', message: 'There were more flows found for a unique context.' });
      }
      var id;
      var version;
      if (results.length === 1 && results[0]._version) {
        id = results[0].id;
        version = results[0]._version;
        if (version !== req.cookies._version) {
          return res.status(500).json({ error: 'Invalid record version', message: 'Record of version that you are modifying is not matching. Reload the node red flows. Warning : Your modifications will be lost.' });
        }
      } else {
        version = uuid.v4();
      }
      results.forEach(function resultsForEach(r) {
        r.flow.forEach(function prepareDbFlow(f) {
          dbFlows.push(f);
        });
      });
      var f = null;
      var index = null;
      var len = dbFlows.length;
      // find out flows which exist in database but not part of POST request - mark for deletion from database
      for (var i = 0; i < len; ++i) {
        f = dbFlows[i];
        index = _.findIndex(reqFlows, function findIndexFn(o) {
          return (o.id === f.id && o.type === f.type);
        });
        if (index < 0) {
          nodesToRemove.push(f);
        }
      }
      // find out flows which exist node-red and also part of POST request, take from what being posted.
      // if credentials are being posted (it may be partially posted), union it with stored credential and save back.
      len = reqFlows.length;
      for (i = 0; i < len; ++i) {
        f = reqFlows[i];
        f.callContext = req.callContext;
        index = _.findIndex(allflows, function findIndexFn(o) {
          return (o.id === f.id && o.type === f.type);
        });
        if (index >= 0) {
          mergeCredentials(f);
          allflows[index] = f;
        } else {
          allflows.push(f);
        }
      }


      len = nodesToRemove.length;
      for (i = 0; i < len; ++i) {
        f = nodesToRemove[i];
        _.remove(allflows, function removeFn(o) {
          return (o.id === f.id && o.type === f.type);
        });
      }
      var obj = { name: autoscopeField, flow: reqFlows, id: id, _version: version };
      flowModel.upsert(obj, req.callContext, function upsertCb(err, results) {
        if (err) {
          console.log(' *** ERROR : NODE RED WAS NOT ABLE TO LOAD FLOWS *** ', err);
          return res.status(500).json({ error: 'unexpected_error', message: 'ERROR : NODE RED WAS NOT ABLE UPDATE FLOWS IN DB' });
        }
        redNodes.setFlows(allflows, deploymentType).then(function setFlowsCb() {
          res.cookie('_version', results._version, { httpOnly: true, secure: (process.env.PROTOCOL && process.env.PROTOCOL === 'https' ? true : false) });
          return res.status(204).end();
        }).otherwise(function setFlowsOtherwiseCb(err) {
          console.log(' *** ERROR : NODE RED WAS NOT ABLE TO LOAD FLOWS *** ', err);
          return res.status(500).json({ error: 'unexpected_error', message: 'ERROR : NODE RED WAS NOT ABLE TO LOAD FLOWS' });
        });
      });
    });

    function mergeCredentials(f) {
      var index2 = _.findIndex(dbFlows, function findIndexFn(o) {
        return (o.id === f.id && o.type === f.type);
      });
      if (index2 >= 0) {
        var nodeType = f.type.replace(/\s+/g, '-');
        var definition = redNodes.getCredentialDefinition(nodeType);
        var savedCredentials = dbFlows[index2].credentials || {};
        var newCreds = f.credentials || {};
        if (!definition) { return; }
        for (var cred in definition) {
          if (definition.hasOwnProperty(cred)) {
            if (typeof newCreds[cred] === 'undefined') {
              continue;
            }
            if (definition[cred].type === 'password' && newCreds[cred] === '__PWRD__') {
              continue;
            }
            if (newCreds[cred].length === 0 || /^\s*$/.test(newCreds[cred])) {
              delete savedCredentials[cred];
              continue;
            }
            savedCredentials[cred] = newCreds[cred];
          }
        }
        f.credentials = savedCredentials;
      }
    }
  });


  // / this function reloads all the flows from database.
  // / this function is being exported from this module so that it can be easily called.
  function reload(redNodes, callback) {
    console.log(' *** NODE-RED : RELOADING FLOWS *** ');
    var flowArray = [];
    var options = {};
    options.ignoreAutoScope = true;
    options.fetchAllScopes = true;
    var flowModel = loopback.findModel('NodeRedFlow');
    flowModel.find({}, options, function findCb(err, results) {
      if (err) {
        callback(err);
      }
      results.forEach(function resultsForEach(r) {
        r.flow.forEach(function prepareFlowArrayFn(f) {
          flowArray.push(f);
        });
      });
      if (flowArray.length > 0) {
        redNodes.setFlows(flowArray).then(function setFlowsFn() {
          callback();
        }).otherwise(function setFlowsOtherwiseFn(err) {
          console.log('node red error');
          callback(err);
        });
      } else {
        return callback();
      }
    });
  }


  // When reloadNodeRedFlows event is received, reload all node red flows.
  messaging.subscribe('reloadNodeRedFlows', function reloadNodeRedFlowsFn(version) {
    reload(redNodes, function reloadFn() { });
  });

  // Atul : As per sachin's comments, moving code from loopback-connector-for-NODE-RED /node-red.js .
  // This is done so that 'NodeRedFlow' model is not tightly attached to loopback-connector- for -NODE - RED
  nodeRed.start({
    port: port,
    settings: settings
  }, function applicationCallback() {
    reload(redNodes, callback);
    // callback();
  });
};
