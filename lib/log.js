// log.js - FireTorrent's module
// author: nikicat

var { Trait } = require('traits');  

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

var LoggedProto = {
    tag: Trait.required,
    _log: function(method, msg, options) {
        console[method](this.tag+': '+ (options && options.noescape ? msg : escape(msg)));
    },
};

for (var fun of ['log', 'debug', 'info', 'warning', 'error']) {
    let f = fun;
    LoggedProto[fun] = function(msg, options) {
        this._log(f, msg, options);
    };
}

const Logged = Trait.compose(LoggedProto);

exports.Logged = Logged;
exports.escape = escape;
