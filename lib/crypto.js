// cryptolib.js - FireTorrent's module
// author: nikicat

//sjcl = require('sjcl');
var {Cc, Ci} = require("chrome");
var hash = Cc["@mozilla.org/security/hash;1"];
var converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"].createInstance(Ci.nsIScriptableUnicodeConverter);
converter.charset = "UTF-8";

function Hash(algorythm) {
    this.ch = hash.createInstance(Ci.nsICryptoHash);
    this.ch.initWithString(algorythm);
}

Hash.prototype = {
    update: function(data) {
        if (typeof(data) === 'string') {
            data = [data.charCodeAt(i) for (i in data)]; 
        }
        this.ch.update(data, data.length);
    },
    digest: function(encoding) {
        switch (encoding) {
            case "hex":
                throw Error("Hash hex encoding not implemented");
            case "base64":
                return this.ch.finish(true);
            case "binary":
            default:
                return this.ch.finish(false);
        }
    }
};

exports.Hash = Hash;
