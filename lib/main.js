const prefs = require('simple-prefs').prefs;
prefs['log.'] = 'TRACE';
prefs['log.peer'] = 'DEBUG';
prefs['log.net'] = 'INFO';
prefs['log.log'] = 'DEBUG';
prefs['log.tfile'] = 'DEBUG';
prefs['log.filestore'] = 'DEBUG';
prefs['log.piece'] = 'TRACE';
prefs['log.torrent'] = 'DEBUG';
prefs['log.torrentmanager'] = 'DEBUG';
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
    const rpc = require('rpc');
} catch (e) {
    console.exception(e);
    console.error(e+'. '+e.fileName+':'+e.lineNumber);
    throw e;
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
