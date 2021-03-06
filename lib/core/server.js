
/* server.coffee */

(function() {
  var Config, ContentPlugin, ContentTree, Stream, async, buildLookupMap, chalk, chokidar, colorCode, enableDestroy, http, keyForValue, loadContent, mime, minimatch, normalizeUrl, pump, ref, renderView, replaceInArray, run, runGenerator, setup, sleep, url, urlEqual;

  async = require('async');

  chokidar = require('chokidar');

  chalk = require('chalk');

  http = require('http');

  mime = require('mime');

  url = require('url');

  minimatch = require('minimatch');

  enableDestroy = require('server-destroy');

  Stream = require('stream').Stream;

  Config = require('./config').Config;

  ref = require('./content'), ContentTree = ref.ContentTree, ContentPlugin = ref.ContentPlugin, loadContent = ref.loadContent;

  pump = require('./utils').pump;

  renderView = require('./renderer').renderView;

  runGenerator = require('./generator').runGenerator;

  colorCode = function(code) {
    switch (Math.floor(code / 100)) {
      case 2:
        return chalk.green(code);
      case 4:
        return chalk.yellow(code);
      case 5:
        return chalk.red(code);
      default:
        return code.toString();
    }
  };

  sleep = function(callback) {
    return setTimeout(callback, 50);
  };

  normalizeUrl = function(anUrl) {
    if (anUrl[anUrl.length - 1] === '/') {
      anUrl += 'index.html';
    }
    if (anUrl.match(/^([^.]*[^\/])$/)) {
      anUrl += '/index.html';
    }
    anUrl = decodeURI(anUrl);
    return anUrl;
  };

  urlEqual = function(urlA, urlB) {
    return normalizeUrl(urlA) === normalizeUrl(urlB);
  };

  keyForValue = function(object, value) {
    var key;
    for (key in object) {
      if (object[key] === value) {
        return key;
      }
    }
    return null;
  };

  replaceInArray = function(array, oldItem, newItem) {
    var idx;
    idx = array.indexOf(oldItem);
    if (idx === -1) {
      return false;
    }
    array[idx] = newItem;
    return true;
  };

  buildLookupMap = function(contents) {
    var i, item, len, map, ref1;
    map = {};
    ref1 = ContentTree.flatten(contents);
    for (i = 0, len = ref1.length; i < len; i++) {
      item = ref1[i];
      map[normalizeUrl(item.url)] = item;
    }
    return map;
  };

  setup = function(env) {

    /* Create a preview request handler. */
    var block, changeHandler, contentHandler, contentWatcher, contents, isReady, loadContents, loadLocals, loadTemplates, loadViews, locals, logop, lookup, requestHandler, templateWatcher, templates, viewsWatcher;
    contents = null;
    templates = null;
    locals = null;
    lookup = {};
    block = {
      contentsLoad: false,
      templatesLoad: false,
      viewsLoad: false,
      localsLoad: false
    };
    isReady = function() {

      /* Returns true if we have no running tasks */
      var k, v;
      for (k in block) {
        v = block[k];
        if (v === true) {
          return false;
        }
      }
      return true;
    };
    logop = function(error) {
      if (error != null) {
        return env.logger.error(error.message, error);
      }
    };
    changeHandler = function(error, path) {

      /* Emits a change event if called without error */
      if (error == null) {
        env.emit('change', path, false);
      }
      return logop(error);
    };
    loadContents = function(callback) {
      if (callback == null) {
        callback = logop;
      }
      block.contentsLoad = true;
      lookup = {};
      contents = null;
      return ContentTree.fromDirectory(env, env.contentsPath, function(error, result) {
        if (error == null) {
          contents = result;
          lookup = buildLookupMap(result);
        }
        block.contentsLoad = false;
        return callback(error);
      });
    };
    loadTemplates = function(callback) {
      if (callback == null) {
        callback = logop;
      }
      block.templatesLoad = true;
      templates = null;
      return env.getTemplates(function(error, result) {
        if (error == null) {
          templates = result;
        }
        block.templatesLoad = false;
        return callback(error);
      });
    };
    loadViews = function(callback) {
      if (callback == null) {
        callback = logop;
      }
      block.viewsLoad = true;
      return env.loadViews(function(error) {
        block.viewsLoad = false;
        return callback(error);
      });
    };
    loadLocals = function(callback) {
      if (callback == null) {
        callback = logop;
      }
      block.localsLoad = true;
      locals = null;
      return env.getLocals(function(error, result) {
        if (error == null) {
          locals = result;
        }
        block.localsLoad = false;
        return callback(error);
      });
    };
    contentWatcher = chokidar.watch(env.contentsPath, {
      ignoreInitial: true
    });
    contentWatcher.on('all', function(type, filename) {
      var i, len, pattern, ref1, relpath;
      if (block.contentsLoad) {
        return;
      }
      relpath = env.relativeContentsPath(filename);
      ref1 = env.config.ignore;
      for (i = 0, len = ref1.length; i < len; i++) {
        pattern = ref1[i];
        if (minimatch(relpath, pattern)) {
          env.emit('change', relpath, true);
          return;
        }
      }
      return loadContents(function(error) {
        var content, contentFilename, j, len1, ref2;
        contentFilename = null;
        if ((error == null) && (filename != null)) {
          ref2 = ContentTree.flatten(contents);
          for (j = 0, len1 = ref2.length; j < len1; j++) {
            content = ref2[j];
            if (content.__filename === filename) {
              contentFilename = content.filename;
              break;
            }
          }
        }
        return changeHandler(error, contentFilename);
      });
    });
    templateWatcher = chokidar.watch(env.templatesPath, {
      ignoreInitial: true
    });
    templateWatcher.on('all', function(event, path) {
      if (!block.templatesLoad) {
        return loadTemplates(changeHandler);
      }
    });
    if (env.config.views != null) {
      viewsWatcher = chokidar.watch(env.resolvePath(env.config.views), {
        ignoreInitial: true
      });
      viewsWatcher.on('all', function(event, path) {
        if (!block.viewsLoad) {
          delete require.cache[path];
          return loadViews(changeHandler);
        }
      });
    }
    contentHandler = function(request, response, callback) {
      var uri;
      uri = normalizeUrl(url.parse(request.url).pathname);
      env.logger.verbose("contentHandler - " + uri);
      return async.waterfall([
        function(callback) {
          return async.mapSeries(env.generators, function(generator, callback) {
            return runGenerator(env, contents, generator, callback);
          }, callback);
        }, function(generated, callback) {
          var error, gentree, i, len, map, tree;
          if (generated.length > 0) {
            try {
              tree = new ContentTree('', env.getContentGroups());
              for (i = 0, len = generated.length; i < len; i++) {
                gentree = generated[i];
                ContentTree.merge(tree, gentree);
              }
              map = buildLookupMap(generated);
              ContentTree.merge(tree, contents);
            } catch (error1) {
              error = error1;
              return callback(error);
            }
            return callback(null, tree, map);
          } else {
            return callback(null, contents, {});
          }
        }, function(tree, generatorLookup, callback) {
          var content, pluginName;
          content = generatorLookup[uri] || lookup[uri];
          if (content != null) {
            pluginName = content.constructor.name;
            return renderView(env, content, locals, tree, templates, function(error, result) {
              var charset, contentType, mimeType;
              if (error) {
                return callback(error, 500, pluginName);
              } else if (result != null) {
                mimeType = mime.lookup(content.filename, mime.lookup(uri));
                charset = mime.charsets.lookup(mimeType);
                if (charset) {
                  contentType = mimeType + "; charset=" + charset;
                } else {
                  contentType = mimeType;
                }
                if (result instanceof Stream) {
                  response.writeHead(200, {
                    'Content-Type': contentType
                  });
                  return pump(result, response, function(error) {
                    return callback(error, 200, pluginName);
                  });
                } else if (result instanceof Buffer) {
                  response.writeHead(200, {
                    'Content-Type': contentType
                  });
                  response.write(result);
                  response.end();
                  return callback(null, 200, pluginName);
                } else {
                  return callback(new Error("View for content '" + content.filename + "' returned invalid response. Expected Buffer or Stream."));
                }
              } else {
                response.writeHead(404, {
                  'Content-Type': 'text/plain'
                });
                response.end('404 Not Found\n');
                return callback(null, 404, pluginName);
              }
            });
          } else {
            return callback();
          }
        }
      ], callback);
    };
    requestHandler = function(request, response) {
      var start, uri;
      start = Date.now();
      uri = url.parse(request.url).pathname;
      return async.waterfall([
        function(callback) {
          if (!block.contentsLoad && (contents == null)) {
            return loadContents(callback);
          } else {
            return callback();
          }
        }, function(callback) {
          if (!block.templatesLoad && (templates == null)) {
            return loadTemplates(callback);
          } else {
            return callback();
          }
        }, function(callback) {
          return async.until(isReady, sleep, callback);
        }, function(callback) {
          return contentHandler(request, response, callback);
        }
      ], function(error, responseCode, pluginName) {
        var delta, logstr;
        if ((error != null) || (responseCode == null)) {
          responseCode = error != null ? 500 : 404;
          response.writeHead(responseCode, {
            'Content-Type': 'text/plain'
          });
          response.end(error != null ? error.message : '404 Not Found\n');
        }
        delta = Date.now() - start;
        logstr = (colorCode(responseCode)) + " " + (chalk.bold(uri));
        if (pluginName != null) {
          logstr += " " + (chalk.grey(pluginName));
        }
        logstr += chalk.grey(" " + delta + "ms");
        env.logger.info(logstr);
        if (error) {
          return env.logger.error(error.message, error);
        }
      });
    };
    loadContents();
    loadTemplates();
    loadViews();
    loadLocals();
    requestHandler.destroy = function() {
      contentWatcher.close();
      templateWatcher.close();
      return viewsWatcher != null ? viewsWatcher.close() : void 0;
    };
    return requestHandler;
  };

  run = function(env, callback) {
    var configWatcher, handler, restart, server, start, stop;
    server = null;
    handler = null;
    if (env.config._restartOnConfChange && (env.config.__filename != null)) {
      env.logger.verbose("watching config file " + env.config.__filename + " for changes");
      configWatcher = chokidar.watch(env.config.__filename);
      configWatcher.on('change', function() {
        var cliopts, config, error, key, value;
        try {
          config = Config.fromFileSync(env.config.__filename);
        } catch (error1) {
          error = error1;
          env.logger.error("Error reloading config: " + error.message, error);
        }
        if (config != null) {
          if (cliopts = env.config._cliopts) {
            config._cliopts = {};
            for (key in cliopts) {
              value = cliopts[key];
              config[key] = config._cliopts[key] = value;
            }
          }
          env.setConfig(config);
          return restart(function(error) {
            if (error) {
              throw error;
            }
            env.logger.verbose('config file change detected, server reloaded');
            return env.emit('change');
          });
        }
      });
    }
    restart = function(callback) {
      env.logger.info('restarting server');
      return async.waterfall([stop, start], callback);
    };
    stop = function(callback) {
      if (server != null) {
        return server.destroy(function(error) {
          handler.destroy();
          env.reset();
          return callback(error);
        });
      } else {
        return callback();
      }
    };
    start = function(callback) {
      return async.series([
        function(callback) {
          return env.loadPlugins(callback);
        }, function(callback) {
          handler = setup(env);
          server = http.createServer(handler);
          enableDestroy(server);
          server.on('error', function(error) {
            if (typeof callback === "function") {
              callback(error);
            }
            return callback = null;
          });
          server.on('listening', function() {
            if (typeof callback === "function") {
              callback(null, server);
            }
            return callback = null;
          });
          return server.listen(env.config.port, env.config.hostname);
        }
      ], callback);
    };
    process.on('uncaughtException', function(error) {
      env.logger.error(error.message, error);
      return process.exit(1);
    });
    env.logger.verbose('starting preview server');
    return start(function(error, server) {
      var host, serverUrl;
      if (error == null) {
        host = env.config.hostname || 'localhost';
        serverUrl = "http://" + host + ":" + env.config.port + env.config.baseUrl;
        env.logger.info("server running on: " + (chalk.bold(serverUrl)));
      }
      return callback(error, server);
    });
  };

  module.exports = {
    run: run,
    setup: setup
  };

}).call(this);
