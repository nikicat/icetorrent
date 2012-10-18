'use strict';

const file = require('file');
const Iterator = require('window-utils').activeBrowserWindow.Iterator;
const {Logged} = require('./log');
const {Class} = require('heritage');
const {EventTarget} = require('event/target');
const {emit} = require('event/core');
const settings = require('simple-prefs').prefs;
const {Piece} = require('./piece');
const {File} = require('./tfile');
const timers = require('timers');

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
        this.path = file.join(settings.downloadDir, info.name);

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
            this.totalLength = 0;
            for each (let fileInfo in info.files) {
                let file = File(this, info, fileInfo, totalLength);
                this.files.push(file);
                this.totalLength += file.length;
            }
        }

        // Initialize pieces array
        let offset = 0;
        for (let i=0; i < info.pieces.length / 20; ++i) {
            let hash = info.pieces.substring(i * 20, (i + 1) * 20);
            let length = Math.min(this.pieceLength, this.totalLength - offset);
            this.pieces[i] = Piece(this, i, hash, length);
            offset += this.pieceLength;
        }

        for each (let file in this.files) {
            for each (let piece in file.pieces) {
                piece.addFile(file);
            }
        }

        this.debug('initialized. piece length '+this.pieceLength+'; piece count '+this.pieces.length);
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
        this.debug('inspecting existent torrent data');
        let it = Iterator(this.pieces);
        (function inspectPiece() {
            it.next()[1].inspect();
            timers.setTimeout(inspectPiece, 0);
        })();
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
                    throw Error("StopIteraton");
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
