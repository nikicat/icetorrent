// log.js - FireTorrent's module
// author: nikicat

const {Trait} = require('traits');  
const {Class, extend} = require('heritage');
const {log4javascript} = require('log4javascript');

function escape(message) {
    function makePrintable(char) {
        var code = char.charCodeAt(0);
        if (31 < code && code < 127)
            return char;
        else
            return "\\x"+("0" + code.toString(16)).slice(-2);
    }
    return [makePrintable(message.charAt(i)) for (i in message)].join("");
}

let appender = extend(log4javascript.Appender.prototype, {
    layout: new log4javascript.PatternLayout('[%d] %c: %m'),
    threshold: log4javascript.Level.DEBUG,

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

console.log(appender instanceof log4javascript.Appender);

function getLogger(name) {
    let logger = log4javascript.getLogger(name);
    logger.addAppender(appender);
    return logger;
}

let LoggedProto = {
    _log: function(method, msg, options) {
        if (!this._logger) {
            this._logger = getLogger(this.toString());
        }
        //this._logger[method](this.tag+': '+ (options && options.noescape ? msg : escape(msg)));
        this._logger[method](msg);
    },
};

for (let fun of ['log', 'trace', 'debug', 'info', 'warning', 'error', 'fatal']) {
    let f = fun;
    LoggedProto[fun] = function(msg) {
        this._log(f, msg);
    };
    let logger = getLogger('');
    exports[fun] = function(msg) {
        logger[fun](msg);
    };
}

const Logged = Class(LoggedProto);
Logged().debug('debug');
Logged().error('error');

exports.Logged = Logged;
exports.escape = escape;
