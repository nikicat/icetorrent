// log.js - FireTorrent's module
// author: nikicat

var { Trait } = require('traits');  

exports.escape = function (message) {
    function makePrintable(char) {
        var code = char.charCodeAt(0);
        if (31 < code && code < 127)
            return char;
        else
            return "\\x"+("0" + code.toString(16)).slice(-2);
    }
    return [makePrintable(message.charAt(i)) for (i in message)].join("");
}

const Logged = Trait.compose({
    tag: Trait.required,
    log: function(msg) {
        console.log(this.tag+': '+msg);
    },
    debug: function(msg) {
        console.debug(this.tag+': '+msg);
    },
    info: function(msg) {
        console.info(this.tag+': '+msg);
    },
    error: function(msg) {
        console.error(this.tag+': '+msg);
    }
});

exports.Logged = Logged;
