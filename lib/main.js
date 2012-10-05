const prefs = require('simple-prefs').prefs;
prefs['log.'] = 'TRACE';
prefs['log.peer'] = 'DEBUG';
prefs['log.net'] = 'INFO';
prefs['log.log'] = 'DEBUG';
prefs['log.filestore'] = 'TRACE';
prefs['log.piece'] = 'TRACE';
prefs['log.torrent'] = 'TRACE';
prefs['log.torrentproto'] = 'TRACE';
prefs['log.magnet'] = 'TRACE';
prefs['log.magnetproto'] = 'TRACE';
prefs['log.httptracker'] = 'TRACE';
prefs['log.udptracker'] = 'TRACE';
prefs['log.swarm'] = 'INFO';

try {
    const {Torrent, torrents} = require('./torrent');
    const {URL} = require('url2');
    require('magnetproto'); // To register magnet: protocol
    require('torrentproto'); // To register magnet: protocol
    require("addon-page");
    const tabs = require('tabs');
    const self = require('self');
    const widget = require("widget");
    const {rpc} = require('rpc');
} catch (e) {
    console.exception(e);
    console.error(e+'. '+e.fileName+':'+e.lineNumber);
    throw e;
}

prefs.destdir = '/tmp';

String.prototype.toBinary = function(){
    var ret = '';
    for (var i = 0; i < this.length; i++) {
        ret += this.charCodeAt(i).toString(2);
    }
    return ret;
}

Object.size = function(obj){
    var size = 0, key;
    for (key in obj) {
        if (obj.hasOwnProperty(key))
            size++;
    }
    return size;
};

//here's antimatter15's implementation, i think they're better
//because at least it works with a fairly fundamental concept
//that binaryToString(stringToBinary(x)) == x;
//logically it does not work with unicodey things
function stringToBinary(bytes){
    var i, b = [];
    for (i = 0; i < bytes.length; i++) {
        b[i] = bytes.charCodeAt(i) & 0xff;
    }
    return b.map(function(v){
        return v.toString(2)
    }).join('')
    /*.split('').map(function(v){
return +v;
});*/
};

function binaryToString(bytes){ //as a string
    if (bytes % 7)
        throw "poop";
    for (var ret = '', l = bytes.length, i = 0; i < l; i += 7) {
        ret += String.fromCharCode(parseInt(bytes.substr(i, 7), 2))
    }
    return ret;
}

String.prototype.fromBinary = function(){
    var ret = '';
    for (var i = 0; i < this.length; i++) {
        ret += String.fromCharCode(parseInt(this.charAt(i)));
    }
    return ret;
}

function parseArgs(args){
    var result = {
        destDir: '.'
    }, torrentFiles = [], i, argLen, arg;
    for (i = 0, argLen = args.length; i < argLen; i += 1) {
        arg = args[i];
        if (arg.length == 0) {
            throw "Empty argument";
        }
        if (arg.charAt(0) == '-') {
            if (arg === '--destDir') {
                result.destDir = args[i + 1];
                i += 1;
            } else {
                throw "Unknown flag " + arg;
            }
        } else {
            torrentFiles.push(arg);
        }
    }
    result.files = torrentFiles;
    return result;
}

exports.main = function () {
    console.info("starting");
    widget.Widget({
        id: "FireTorrent",
        label: "FireTorrent",
        contentURL: self.data.url("transmission-icon.png"),
        onClick: function() {
            tabs.open({
                url: self.data.url("index.html"),
                onReady: function(tab) {
                    console.info('attaching to tab');
                    let worker = tab.attach({
                        contentScriptWhen: 'start',
                        contentScriptFile: self.data.url('message.js')
                    });
                    worker.port.on('message', function(message) {
                        worker.port.emit('message', rpc.onMessage(message));
                    });
                }
            });
        }
    });
}
