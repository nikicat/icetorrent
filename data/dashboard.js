//console.debug('onopen');
/*document.body.onload = function () {
    console.debug('onload');
}
    document.newtorrent.onsubmit = function(){
        console.debug('newtorrent');
        self.postMessage({type: "newtorrent", uri: document.newtorrent.uri.value});
        return false;
    };*/
//};


$(function(){
    var Peer = Backbone.AssociatedModel.extend({
    });
    var Piece = Backbone.AssociatedModel.extend({
    });
    var Torrent = Backbone.AssociatedModel.extend({
        relations: [{
            relatedModel: Peer,
            key: 'peers',
            type: Backbone.Many
        },{
            relatedModel: Piece,
            key: 'pieces',
            type: Backbone.Many
        }]
    });
    var Root = Backbone.AssociatedModel.extend({
        relations: [{
            relatedModel: Torrent,
            key: 'torrents',
            type: Backbone.Many
        }],
        url: '/'
    });

    var TorrentView = Backbone.View.extend({
        tagName: 'torrent',
        className: 'torrent',
        template: $('#torrent-template').html(),
        render: function () {
            this.$el.html(this.template);
            rivets.bind(this.$el, {torrent: this.model});
            return this;
        },
        events: {
            'click .peers': 'openPeers'
        },
        openPeers: function() {
            this.remove();
            var view = new PeerListView({
                collection: this.model.get('peers')
            });
            view.render();
        }
    });

    var TorrentListView = Backbone.View.extend({
        el: $('#torrents'),

        render: function () {
            _.each(this.collection.models, function (item) {
                this.renderTorrent(item);
            }, this);
        },

        renderTorrent: function(torrent) {
            var torrentView = new TorrentView({
                model: torrent
            });
            this.$el.append(torrentView.render().el);
        }
    });

    var DashboardView = Backbone.View.extend({
        el: $('body'),

        initialize: function() {
            this.torrents = new TorrentListView({
                collection: this.model.get('torrents')
            });
        },

        render: function() {
            rivets.bind(this.$el, {dashboard: this.model});
            this.torrents.render();
        }
    });

    var PeerView = Backbone.View.extend({
        template: $('#peer-template').html(),
        render: function() {
            this.$el.html(this.template);
            rivets.bind(this.$el, {peer: this.model});
        }
    });

    var PeerListView = Backbone.View.extend({
        template: $('#peers-template').html(),
        render: function() {
            this.$el.html(this.template);
            _.each(this.collection.models, function(item) {
                this.renderPeer(item);
            }, this);
        },

        renderPeer: function(peer) {
            var peerView = new PeerView({
                model: peer
            });
            this.$el.append(peerView.render().el);
        }
    });

    var syncCallbacks = [];
    var id = 0;

    Backbone.sync = function(method, model, options) {
        console.debug('sync '+method+' '+model.url+' '+JSON.stringify(options));
        var myid = id++;
        syncCallbacks[myid] = options.success;
        self.postMessage({
            method: method,
            url: model.url,
            id: myid
        });
    };

    var root = new Root();

    var Dashboard = Backbone.Router.extend({
        routes: {
            '': 'overview',
            ':torrent/peers': 'peers',
            ':torrent/pieces': 'pieces'
        },
        overview: function() {
            if (this.view) {
                this.view.remove();
            }
            this.view = new Overview(root);
            this.view.render();
        },
        peers: function(torrent) {
            this.view.remove();
            this.view = new PeerListView(this._findTorrent(torrent).get('peers'));
        },
        pieces: function(torrent) {
            this.view.remove();
            this.view = new PieceListView(this._findTorrent(torrent).get('pieces'));
        },
        _findTorrent: function(hash) {
            for each (t in root.get('torrents')) {
                if (t.hash == hash) {
                    return t;
                }
            }
        }
    });

    window.on('message', function(message) {
        if (message == 'update') {
            root.fetch();
        } else {
            console.debug('received message id: '+message.id+' data: '+JSON.stringify(message.data));
            var callback = syncCallbacks[message.id];
            delete syncCallbacks[message.id];
            callback(message.data);
        }
    });

    rivets.configure({
        adapter: {
            subscribe: function(obj, keypath, callback) {
                obj.on('change:' + keypath, callback)
            },
            unsubscribe: function(obj, keypath, callback) {
                obj.off('change:' + keypath, callback)
            },
            read: function(obj, keypath) {
                return obj.get(keypath)
            },
            publish: function(obj, keypath, value) {
                obj.set(keypath, value)
            }
        }
    });

    var dashboard = new Dashboard();
    dashboard.navigate('/');
    root.fetch();
    console.debug('loaded');
});
