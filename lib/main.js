const prefs = require('simple-prefs').prefs;
prefs['log.'] = 'TRACE';
prefs['log.peer'] = 'DEBUG';
prefs['log.net'] = 'DEBUG';
prefs['log.log'] = 'DEBUG';
prefs['log.filestore'] = 'TRACE';
prefs['log.torrent'] = 'TRACE';
prefs['log.magnet'] = 'TRACE';
prefs['log.httptracker'] = 'TRACE';
prefs['log.udptracker'] = 'TRACE';

try {
    const {Torrent, torrents} = require('./torrent');
    const {URL} = require('url2');
    require('magnetproto'); // To register magnet: protocol
    require('torrentproto'); // To register magnet: protocol
    require("addon-page");
    const tabs = require('tabs');
    const self = require('self');
    const widget = require("widget");
    const log = require('log');
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
                url: self.data.url("dashboard.html"),
                onReady: function(tab) {
                    let worker = tab.attach({
                        contentScriptWhen: 'start',
                        contentScriptFile: self.data.url('message.js'),
                        onMessage: function(message){
                            console.info('message: ' + JSON.stringify(message));
                            if (message.type == 'newtorrent') {
                                console.info('new torrent: ' + message.uri);
                                var torrent = Torrent();
                                torrent.loadFromFile(message.uri, function(error) {
                                    if (!error) {
                                        torrent.checkFiles(function(error) {
                                            if (!error) {
                                                torrent.start();
                                            }
                                        });
                                    }
                                });
                            } else if (message.method == 'read' && message.url == '/') {
                                console.debug('posting message id='+message.id+' data: '+torrents);
                                worker.postMessage({
                                    id: message.id,
                                    data: torrents.webInfo
                                });
                            }
                        }
                    });
                    torrents.on('changed', function() {
                        worker.postMessage('update');
                    });
                }
            });
        }
    });
    // DEBUG HELPER
    //var torrent = Torrent();

    //let logger = log.getLogger('main');
/*    torrent.loadFromMagnet(new URL('magnet:?xt=urn:btih:7ea1b59cce1737437a66e29a2843b5ce3a0c8cd9&dn=Billy+Van+Dubstep+Media+Bundle&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80&tr=udp%3A%2F%2Ftracker.publicbt.com%3A80&tr=udp%3A%2F%2Ftracker.istole.it%3A6969&tr=udp%3A%2F%2Ftracker.ccc.de%3A80'), 
//    torrent.create("/home/nbryskin/Downloads/[rutracker.org].t4073806.torrent", prefs.destdir); // medium
//    var torrent = new Torrent("/home/nbryskin/Downloads/[rutracker.org].t4091232.torrent", prefs.destdir); // tiny
//    torrent.loadFromFile('/home/nbryskin/Downloads/[isoHunt] Linkin Park - LIVING THINGS - 2012 (320 kbps).torrent', // with udp trackers
        function(error) {
            if (!error) {
                torrent.checkFiles(function(error) {
                    if (!error) {
                        torrent.start(function(data) {
                            if (data === null) {
                                logger.info('torrent downloaded');
                            } else {
                                logger.info('new data with length '+data.length);
                            }
                        }, true);
                    }
                });
            }
        });
*/
}
