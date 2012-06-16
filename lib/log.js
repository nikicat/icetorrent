// log.js - FireTorrent's module
// author: nikicat

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