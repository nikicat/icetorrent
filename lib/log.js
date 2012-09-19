// log.js - FireTorrent's module
// author: nikicat

'use strict';

const {Trait} = require('traits');  
const { Class, extend, mix } = require('heritage');
const {log4javascript} = require('log4javascript');
const traceback = require('traceback');
const prefs = require('simple-prefs').prefs;

function escape(message) {
    function makePrintable(char) {
        var code = char.charCodeAt(0);
        if (31 < code && code < 127)
            return char;
        else
            return "\\x"+("0" + code.toString(16)).slice(-2);
    }
    if (message === undefined || message === null)
        return message;
    return [makePrintable(message.charAt(i)) for (i in message)].join("");
}
exports.esc = exports.escape = escape;

let Appender = function() {
}

Appender.prototype = mix(new log4javascript.Appender(), {
    threshold: log4javascript.Level.TRACE,
    append: function(loggingEvent) {
		var appender = this;

		var getFormattedMessage = function() {
			var layout = appender.getLayout();
			var formattedMessage = layout.format(loggingEvent);
			if (layout.ignoresThrowable() && loggingEvent.exception) {
				formattedMessage += loggingEvent.getThrowableStrRep();
			}
			return formattedMessage;
		};

        var formattedMesage = getFormattedMessage();
        dump(formattedMesage+'\n');
	},
    toString: function() {
		return "NativeConsoleAppender";
	}
});

let appender = new Appender();
let layout = new log4javascript.PatternLayout('[%d] %p %c[%f]: %m');
layout.setCustomField('tag', function (layout, logevent) logevent.origin ? logevent.origin.tag : 'unset');
appender.setLayout(layout);

function getLevel(name) {
    let levelstr = prefs['log.'+name];
    logLogger.trace('pref value for log.'+name+' is '+levelstr);
    let level = log4javascript.Level[levelstr];
    return level ? level : log4javascript.Level.DEBUG;
}

function getLogger(name, tag) {
    let logger = log4javascript.getLogger(name);
    let level = getLevel(name);
    logLogger.trace('setting level for '+name+' to '+level);
    logger.setLevel(level);
    logger.addAppender(appender);
    return logger;
}


var logLogger = log4javascript.getLogger('log');
logLogger.origin = {tag: 'global'};
logLogger = getLogger('log');

let LoggedProto = {
    _log: function(method, args) {
        if (!this._logger) {
            let stack = traceback.get();
            let name = stack[stack.length-3].filename.replace(/.*\/lib\/(.+)\.js/, '$1');
            this._logger = getLogger(name);
        }
        let argsWithThis = [].concat([args[i] for (i in args)], [this]);
        this._logger[method].apply(this._logger, argsWithThis);
    },
    toString: function() {
        return this.name + '<' + this.tag + '>';
    }
};

for (let fun of ['log', 'trace', 'debug', 'info', 'warn', 'error', 'fatal', 'assert']) {
    let f = fun;
    LoggedProto[fun] = function() {
        this._log(f, arguments);
    };
    let logger = getLogger('');
    exports[fun] = function() {
        logger[fun].apply(logger, arguments);
    };
}

const Logged = Class(LoggedProto);

exports.Logged = Logged;
exports.getLogger = getLogger;
