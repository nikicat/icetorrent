'use strict';

const bitfield = require('./bitfield');
const path = require('path');
const timers = require('timers');
const {Logged} = require('./log');
const {Class} = require('heritage');
const {EventTarget} = require('event/target');
const {emit} = require('event/core');
const {destDir} = require('./settings');
const {Piece} = require('./piece');

const File = Class({
    implements: [Logged, EventTarget],
    initialize: function(store, info, file, offset) {
        this.store = store;
        this.name = file.path.join('/');
        this.tag = file.path[file.path.length-1];
        this.path = path.join(destDir, info.name, file.path);
        this.offset = offset;
        this.length = file.length;
        this.md5sum = file.md5sum;
        this.notifyOffset = this.offset;
        this.notifyInProgress = false;
        this.wanted = false;
        this.store.on('havepiece', (function(piece) {
            if (this.pieces.indexOf(piece.index) != -1) {
                this.debug('received piece '+piece.index);
                emit(this, 'havepiece', piece);
                if (!this.notifyInProgress) {
                    this.notify();
                }
            }
        }).bind(this));
        this.debug('initialized. name: '+this.name+'; path: '+this.path+'; offset: '+this.offset+'; length: '+this.length+'; md5sum: '+this.md5sum);
    },

    get bytesCompleted () {
        let result = 0;
        for each (let piece in this.pieces) {
            if (piece.good) {
                result += this.getPieceIntersection(piece);
            }
        }
        return result;
    },

    getPieceIntersection: function(piece) {
        return Math.min(piece.offset + piece.length, this.offset + this.length) - Math.max(piece.offset, this.offset);
    },

    notify: function() {
        this.notifyInProgress = true;
        if (this.notifyOffset < this.offset + this.length) {
            let piece = this.getPieceForOffset(this.notifyOffset);
            if (piece.good) {
                piece.readPiece((function(error, data) {
                    if (!error) {
                        if (data !== null) {
                            let from = this.notifyOffset % this.store.pieceLength;
                            let to = Math.min(this.offset + this.length - this.notifyOffset, data.length);
                            let subdata = data.slice(from, to);
                            this.notifyOffset += subdata.length;
                            emit(this, 'data', subdata);
                            this.notify();
                        }
                    } else {
                        this.error('failed to notify about data: '+error);
                        this.notifyInProgress = false;
                    }
                }).bind(this));
            } else {
                this.notifyInProgress = false;
            }
        } else {
            emit(this, 'end');
            this.notifyInProgress = false;
        }
    },

    getPieceForOffset: function(offset) {
        return this.store.pieces[Math.floor(offset / this.store.pieceLength)];
    },

    get pieces () {
        let res = [];
        let begin = this.getPieceForOffset(this.offset);
        let end = this.getPieceForOffset(this.offset + this.length - 1);
        for (let i=begin.index; i<=end.index; i++) {
            res.push(this.store.pieces[i]);
        }
        return res;
    },

    getNeededPieces: function() {
        let needed = [];
        for each (let piece in this.pieces) {
            if (!piece.good) {
                needed.push(piece);
            }
        }
        return needed;
    }
});

/*
 * Filestore: { pieceLength, pieces, files: [{path offset length md5}...],
 *     left }
 * offset is in increasing order, so that binary search can find a given absolute offset.
 */
const Store = Class({
    implements: [Logged, EventTarget],
    name: 'Store',
    initialize: function(info) {
        this.files = [];
        this.pieces = [];
        this.pieceLength = info['piece length'];
        this.tag = info.name;
        this.downloadDir = destDir;

        // Check if this is a single file torrent or a file list torrent
        if (info.length !== undefined) {
            // single file
            let file = File(this, info, { 
                path: [''],
                length: info.length,
                md5: info.md5
            }, 0);
            this.files.push(file);
            this.totalLength = info.length;
        } else {
            this.parseMultipleFiles(info, destDir);
        }
        // Initialize pieces array
        let offset = 0;
        for (let i=0; i < info.pieces.length / 20; ++i) {
            let hash = info.pieces.substring(i * 20, (i + 1) * 20);
            let length = Math.min(this.pieceLength, this.totalLength - offset);
            this.pieces[i] = new Piece(this, i, hash, length);
            offset += this.pieceLength;
        }

        this.debug('initialized. piece length '+this.pieceLength+'; piece count '+this.pieces.length);
    },

    parseMultipleFiles: function(info, destDir) {
        let totalLength = 0;
        for each (let fileInfo in info.files) {
            let file = File(this, info, fileInfo, totalLength);
            this.files.push(file);
            totalLength += file.length;
        }
        this.totalLength = totalLength;
    },

    getFile: function(name) {
        if (name === '' && this.files.length === 1) {
            return this.files[0];
        } else {
            for each (let file in this.files) {
                this.debug('comparing '+file.name+' against '+name);
                if (file.name == name) {
                    return file;
                }
            }
        }
        throw Error('no file with path '+name);
    },

    havePiece: function(index) {
        return this.pieces[index].good === true;
    },

    inspect: function(callback){
        this.trace('inspecting existent torrent data');
        function inspectCallback(piece, err) {
            let goodPiece = err === null;
            if (!goodPiece) {
                emit(this, 'needpiece', piece);
            } else {
                emit(this, 'havepiece', piece);
            }
            if (piece.index + 1 < this.pieces.length) {
                let nextPiece = this.pieces[piece.index+1];
                timers.setTimeout(nextPiece.inspect.bind(nextPiece, inspectCallback.bind(this, nextPiece)), 0);
            } else {
                this.debug('finished inspecting torrent data');
            }
        }
        this.pieces[0].inspect(inspectCallback.bind(this, this.pieces[0]));
    },

    addPieceFragment: function(index, offset, data) {
        if (index >= 0 && index < this.pieces.length) {
            emit(this, 'piecefragment', index, offset, data);
            this.pieces[index].addFragment(offset, data);
        } else {
            throw new Error('piece index '+index+' is out of bound '+this.pieces.length);
        }
    },

    // Find file that associates with offset
    // returns index of file
    findFile: function(offset) {
        let a = -1;
        let b = this.files.length;
        // find file using bunary search
        while (a < b) {
            let c = (a + b) >> 1;
            let file = this.files[c];
            if (file.offset <= offset && file.offset + file.length > offset) {
                return c;
            } else {
                if (file.offset < offset) {
                    a = c;
                } else {
                    b = c;
                }
            }
        }
        throw new Error('could not find file with offset '+offset);
    },

    // Returns an iterator object with two methods: hasNext() and next().
    // Next will return {file, offset, length}
    createRangeIterator: function(offset, length){
        let i = this.findFile(offset);
        return {
            hasNext: function() {
                return length > 0;
            },
            next: (function() {
                if (length <= 0) {
                    throw new Error("StopIteraton");
                }
                let file = this.files[i];
                let fileOffset = offset - file.offset;
                let fileLength = Math.min(file.length - fileOffset, length);
                i += 1;
                length -= fileLength;
                offset += fileLength;
                return {
                    file: file,
                    offset: fileOffset,
                    length: fileLength
                };
            }).bind(this)
        };
    }
});

exports.Store = Store;
