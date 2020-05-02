/**
 * @fileoverview Command-line interface to disk image processing module
 * @author Jeff Parsons <Jeff@pcjs.org>
 * @copyright © 2012-2020 Jeff Parsons
 * @license MIT <https://www.pcjs.org/LICENSE.txt>
 *
 * This file is part of PCjs, a computer emulation software project at <https://www.pcjs.org>.
 */

import fs         from "fs";
import crypto     from "crypto";
import glob       from "glob";
import path       from "path";
import DataBuffer from "../../modules/nodebuffer.js";
import StdLib     from "../../modules/stdlib.js";
import Device     from "../../../machines/modules/device.js";
import JSONLib    from "../../../machines/modules/jsonlib.js";
import DiskImage  from "../../../machines/pcx86/modules/diskimage.js";

let device = new Device("node");
let printf = device.printf.bind(device);
let sprintf = device.sprintf.bind(device);
let stdlib = new StdLib();
let rootDir, nMaxFiles;

/*
 * List of text file types to convert line endings from LF to CR+LF when "--normalize" is specified.
 * A warning is always displayed when we replace line endings in any file being copied to a disk image.
 *
 * NOTE: Some files, like ".BAS" files, aren't always ASCII, which is why we now call isASCII() on all
 * these file contents first.
 */
let asTextFileExts = [".MD", ".ME", ".BAS", ".BAT", ".ASM", ".LRF", ".MAK", ".TXT", ".XML"];

/**
 * compareDisks(sDisk1, sDisk2)
 *
 * @param {string} sDisk1
 * @param {string} sDisk2
 * @returns {boolean} (true if the contents of this buffer are equal to the contents of the specified buffer, false otherwise)
 */
function compareDisks(sDisk1, sDisk2)
{
    /*
     * Passing null for the encoding parameter tells readFile() to return a buffer (which, in our case, is a DataBuffer).
     */
    let db1 = readFile(sDisk1, null);
    let db2 = readFile(sDisk2, null);
    return db1 && db2 && db1.compare(db2) || false;
}

/**
 * getHash(data, type)
 *
 * @param {Array.<number>|DataBuffer} data
 * @param {string} [type] (eg, "md5")
 * @returns {string}
 */
function getHash(data, type = "md5")
{
    let db;
    if (data instanceof DataBuffer) {
        db = data;
    } else {
        db = new DataBuffer(data);
    }
    return crypto.createHash(type).update(db.buffer).digest('hex');
}

/**
 * isASCII(cata)
 *
 * @param {string} data
 * @return {boolean} true if sData is entirely ASCII (ie, no bytes with bit 7 set)
 */
function isASCII(data)
{
    for (let i = 0; i < data.length; i++) {
        let b = data.charCodeAt(i);
        if (b & 0x80) return false;
    }
    return true;
}

/**
 * isTextFile(sFile)
 *
 * @param {string} sFile
 * @return {boolean} true if the filename contains a known text file extension, false if unknown
 */
function isTextFile(sFile)
{
    let sFileUC = sFile.toUpperCase();
    for (let i = 0; i < asTextFileExts.length; i++) {
        if (sFileUC.endsWith(asTextFileExts[i])) return true;
    }
    return false;
}

/**
 * readDir(sDir, fNormalize, sLabel, kbTarget, nMax)
 *
 * @param {string} sDir (directory name)
 * @param {boolean} [fNormalize] (if true, known text files get their line-endings "fixed")
 * @param {string} [sLabel] (if not set with --label, then basename(sDir) will be used instead)
 * @param {number} [kbTarget] (target disk size, in Kb)
 * @param {number} [nMax] (maximum number of files to read; default is 256)
 * @returns {DiskImage|null}
 */
function readDir(sDir, fNormalize = false, sLabel, kbTarget, nMax)
{
    let di;
    if (!sLabel) sLabel = path.basename(sDir);
    try {
        nMaxFiles = nMax || 256;
        let aFileData = readDirFiles(sDir, fNormalize, sLabel);
        di = new DiskImage(device);
        let db = new DataBuffer();
        if (!di.buildDiskFromFiles(db, path.basename(sDir), aFileData, kbTarget || 0)) {
            di = null;
        }
    } catch(err) {
        printf("error: %s\n", err.message);
        di = null;
    }
    return di;
}

/**
 * readDirFiles(sDir, fNormalize, sLabel)
 *
 * @param {string} sDir (directory name)
 * @param {boolean} [fNormalize] (if true, known text files get their line-endings "fixed")
 * @param {boolean} [sLabel] (optional volume label; this should NEVER be set when reading subdirectories)
 * @returns {Array.<FileData>}
 */
function readDirFiles(sDir, fNormalize = false, sLabel)
{
    let aFileData = [];
    let asFiles = fs.readdirSync(sDir);

    /*
     * There are two special label strings you can pass on the command-line:
     *
     *      "--label none" (for no volume label at all)
     *      "--label default" (for our default volume label; currently "PCJS")
     *
     * Any other string following "--label" will be used as-is, and if no "--label" is specified
     * at all, we build a volume label from the basename of the directory.
     */
    if (sLabel == "none") {
        sLabel = "";
    } else if (sLabel == "default") {
        sLabel = DiskImage.PCJS_LABEL;
    }

    /*
     * The label, if any, will always be first in the list; this shouldn't be a concern since
     * there is currently no support for building "bootable" disks from a set of files.
     */
    if (sLabel) {
        /*
         * I used to prefer a hard-coded date/time (eg, the day the IBM PC was introduced, August 12, 1981,
         * with an arbitrary time of 12pm), in part because it avoided creating different disk images every
         * time DiskDump was run.  However, I'm not sure I care about that anymore.  Having a timestamp
         * that reflects the creation date of the disk image seems more useful.
         */
        let dateLabel = new Date();
        let file = {path: sDir, name: sLabel, attr: DiskImage.ATTR.VOLUME, date: dateLabel, size: 0};
        aFileData.push(file);
    }

    for (let iFile = 0; iFile < asFiles.length && nMaxFiles > 0; iFile++, nMaxFiles--) {
        /*
         * fs.readdir() already excludes "." and ".." but there are also a wide variety of hidden
         * files on *nix systems that begin with a period, which in general we should ignore, too.
         *
         * TODO: Consider an override option that will allow hidden file(s) to be included as well.
         */
        let sName = asFiles[iFile];
        if (sName.charAt(0) == '.') continue;
        let sPath = path.join(sDir, sName);
        let file = {path: sPath, name: sName};
        let stats = fs.statSync(sPath);
        file.date = stats.mtime;
        if (stats.isDirectory()) {
            file.attr = DiskImage.ATTR.SUBDIR;
            file.size = -1;
            file.data = new DataBuffer();
            file.files = readDirFiles(sPath, fNormalize);
        } else {
            let fText = fNormalize && isTextFile(sName);
            let data = readFile(sPath, fText? "utf8" : null);
            if (!data) continue;
            if (data.length != stats.size) {
                printf("file data length (%d) does not match file size (%d)\n", data.length, stats.size);
            }
            if (fText) {
                if (isASCII(data)) {
                    let dataNew = data.replace(/\n/g, "\r\n").replace(/\r+/g, "\r");
                    if (dataNew != data) printf("replaced line endings in %s (size changed from %d to %d bytes)\n", sName, data.length, dataNew.length);
                    data = dataNew;
                } else {
                    printf("non-ASCII data in %s (line endings unchanged)\n", sName);
                }
                data = new DataBuffer(data);
            }
            file.attr = 0;      // TODO: Determine when we should specify, say, DiskImage.ATTR.ARCHIVE
            file.size = data.length;
            file.data = data;
        }
        aFileData.push(file);
    }
    return aFileData;
}

/**
 * readDisk(sFile, forceBPB, sectorIDs, sectorErrors, suppData)
 *
 * @param {string} sFile
 * @param {boolean} [forceBPB]
 * @param {Array|string} [sectorIDs]
 * @param {Array|string} [sectorErrors]
 * @param {string} [suppData] (eg, supplementary disk data that can be found in such files as: /software/pcx86/app/microsoft/word/1.15/debugger/index.md)
 * @returns {DiskImage|null}
 */
function readDisk(sFile, forceBPB, sectorIDs, sectorErrors, suppData)
{
    let db, di
    try {
        let diskName = path.basename(sFile);
        di = new DiskImage(device, diskName);
        if (diskName.endsWith(".json")) {
            db = fs.readFileSync(sFile, "utf8");
            if (!di.buildDiskFromJSON(db)) di = null;
        }
        else {
            db = new DataBuffer(fs.readFileSync(sFile));
            let hash = getHash(db);
            if (diskName.endsWith(".psi")) {
                if (!di.buildDiskFromPSI(db)) di = null;
            } else {
                if (!di.buildDiskFromBuffer(db, hash, forceBPB, sectorIDs, sectorErrors, suppData)) di = null;
            }
        }
    } catch(err) {
        printf("error: %s\n", err.message);
        return null;
    }
    return di;
}

/**
 * readFile(sFile, encoding)
 *
 * @param {string} sFile
 * @param {string|null} [encoding]
 * @returns {DataBuffer|string|undefined}
 */
function readFile(sFile, encoding = "utf8")
{
    let data;
    if (sFile) {
        try {
            if (fs.existsSync(sFile)) {
                data = fs.readFileSync(sFile, encoding);
                if (!encoding) data = new DataBuffer(data);
            }
        } catch(err) {
            printf("error: %s\n", err.message);
        }
    }
    return data;
}

/**
 * readJSON(sFile)
 *
 * @param {string} sFile
 * @returns {Object|undefined}
 */
function readJSON(sFile)
{
    let data, json;
    try {
        data = fs.readFileSync(sFile, "utf8");
        json = JSON.parse(data);
    } catch(err) {
        printf("error: %s\n", err.message);
    }
    return json;
}

/**
 * writeDisk(sFile, di, fLegacy, indent, fOverwrite)
 *
 * @param {string} sFile
 * @param {DiskImage} di
 * @param {boolean} [fLegacy]
 * @param {number} [indent]
 * @param {boolean} [fOverwrite]
 */
function writeDisk(sFile, di, fLegacy = false, indent = 0, fOverwrite = false)
{
    let diskName = path.basename(sFile);
    try {
        let fExists = fs.existsSync(sFile);
        if (!fExists || fOverwrite) {
            let data;
            let sFileUC = sFile.toUpperCase();
            if (sFileUC.endsWith(".JSON")) {
                data = di.getJSON(getHash, fLegacy, 0);
            } else {
                let db = new DataBuffer(di.getSize());
                if (di.getData(db)) data = db.buffer;
            }
            if (data) {
                printf("writing  %s...\n", sFile.indexOf(path.delimiter) == 0? sFile.substr(rootDir.length) : sFile);
                if (fExists) fs.unlinkSync(sFile);
                fs.writeFileSync(sFile, data);
                if (sFileUC.endsWith(".IMG")) fs.chmodSync(sFile, 0o444);
            } else {
                printf("%s not written, no data\n", diskName);
            }
        } else {
            printf("%s exists, use --overwrite to replace\n", diskName);
        }
    }
    catch(err) {
        printf("error: %s\n", err.message);
    }
}

/**
 * writeFile(sFile, data)
 *
 * @param {string} sFile
 * @param {DataBuffer|string} data
 * @returns {boolean}
 */
function writeFile(sFile, data)
{
    if (sFile) {
        try {
            if (data instanceof DataBuffer) {
                data = data.buffer;
            }
            fs.writeFileSync(sFile, data);
            return true;
        } catch(err) {
            printf("error: %s\n", err.message);
        }
    }
    return false;
}

/**
 * main(argc, argv)
 *
 * @param {number} argc
 * @param {Array} argv
 */
function main(argc, argv)
{
    Device.DEBUG = !!argv['debug'];
    rootDir = path.join(path.dirname(argv[0]), "../../..");

    if (Device.DEBUG) {
        printf("diskdump v%s\n", Device.VERSION);
        device.setMessages(Device.MESSAGE.FILE + Device.MESSAGE.INFO, true);
    }
    device.setMessages(Device.MESSAGE.DISK + Device.MESSAGE.WARN + Device.MESSAGE.ERROR, true);

    let input, di;
    if ((input = argv['disk'])) {
        di = readDisk(input, argv['forceBPB'], argv['sectorID'], argv['sectorError'], readFile(argv['suppData']));
    }
    else if ((input = argv['dir'])) {
        di = readDir(input, argv['normalize'], argv['label'], +argv['target'], +argv['maxfiles']);
    }
    if (di === null) return;
    if (di) {
        di.setArgs(argv.slice(1).join(' '));
        printf("disk size: %d\n", di.getSize());
        if (argv['list']) {
            let iVolume = +argv['volume'];
            if (isNaN(iVolume)) iVolume = -1;
            let list = di.getFileListing(iVolume);
            printf(list);
        }
        if (argv['dump']) {
            let manifest = di.getFileManifest(getHash);
            manifest.forEach(function dumpFiles(file) {
                if (file['md5']) {
                    printf("%s  %-12s  %s  %s:%s\n", file['md5'], file.name, file.date, di.getName(), file.path);
                }
            });
        }
        let output = argv['output'];
        if (output) writeDisk(output, di, argv['legacy'], argv['indent']? 2 : 0, argv['overwrite']);
        return;
    }

    if (argv['readall']) {
        let family = "pcx86";
        let cConfigs = 0, cManifests = 0, cFiles = 0;
        let asFiles = glob.sync(path.join(rootDir, "/configs/" + family + "/*.json"));
        asFiles.forEach(function readAllConfigs(sFile) {
            if (argv['verbose']) printf("reading  %s...\n", sFile.substr(rootDir.length));
            let library = readJSON(sFile);
            if (library) {
                let aDiskettes = [];
                JSONLib.parseDiskettes(aDiskettes, library, "/pcx86", "/diskettes");
                aDiskettes.forEach(function readAllDiskettes(diskette) {
                    let sFile = path.join(rootDir, diskette.path);
                    if (argv['verbose']) printf("reading  %s...\n", sFile.substr(rootDir.length));
                    let di = readDisk(sFile);
                    if (!di) return;

                    let optc = 0, optv = [];
                    if (!diskette.options) {
                        diskette.options = "";
                    } else {
                        [optc, optv] = stdlib.getArgs(diskette.options);
                        diskette.options = ' ' + diskette.options;
                    }

                    /*
                     * Task #1: If --rebuild, then rewrite the JSON disk image.
                     */
                    if (argv['rebuild']) {
                        if (sFile.endsWith(".json")) {
                            writeDisk(sFile, di, false, 0, true);
                        }
                    }
                    /*
                     * Task #2: If --checklisting, then get the disk's listing and see if it's up-to-date in the website's index.md
                     */
                    if (argv['checklisting']) {
                        let sListing = di.getFileListing(0, 4);
                        if (!sListing) return;
                        let sIndexFile = path.join(path.dirname(sFile.replace("/diskettes/", "/software/")), "index.md");
                        if (fs.existsSync(sIndexFile)) {
                            let sIndex = readFile(sIndexFile);
                            let sMatch = "\n(##+)\\s+Directory of " + diskette.name.replace("(","\\(").replace(")","\\)").replace("*","\\*") + "\n([\\s\\S]*?)\n(\\S|$)";
                            let matchDirectory = sIndex.match(new RegExp(sMatch));
                            if (matchDirectory) {
                                let sIndexNew = sIndex.replace(matchDirectory[2], sListing);
                                if (sIndexNew != sIndex) {
                                    if (writeFile(sIndexFile, sIndexNew)) {
                                        printf("\tupdated directory listing for \"%s\"\n", diskette.name);
                                    }
                                }
                            } else {
                                printf("\twarning: no directory listing for \"%s\"\n", diskette.name);
                            }
                        } else {
                            printf("\tmissing index: %s\n", sIndexFile);
                        }
                    }

                    /*
                     * Task #3: If --checkarchive, then let's load the corresponding archived disk image (.IMG) as well, convert it to JSON,
                     * load the JSON as a disk image, save it as a temp .IMG, and verify that temp image and archived image are identical.
                     *
                     * To check a specific archive, use --checkarchive=[IMG filename].
                     */
                    if (argv['checkarchive']) {
                        if (sFile.endsWith(".json")) {
                            if (typeof argv['ignore'] == "string" && sFile.indexOf(argv['ignore']) >= 0) return;
                            let sArchiveFolder = "archive/";
                            if (path.dirname(sFile).endsWith("/disks")) {
                                sArchiveFolder = "../archive/";
                            }
                            let sArchiveFile = path.join(path.dirname(sFile), sArchiveFolder, path.basename(sFile).replace(".json", ".img"));
                            if (diskette.archive) {
                                if (diskette.archive == "folder") {
                                    sArchiveFile = sArchiveFile.replace(".img","/");
                                } else {
                                    sArchiveFile = sArchiveFile.replace(".img",'.'+diskette.archive);
                                }
                            }
                            if (typeof argv['checkarchive'] != "string" || sArchiveFile.indexOf(argv['checkarchive']) >= 0) {
                                printf("reading  %s...\n", sArchiveFile.substr(rootDir.length));
                                let sectorIDs = argv['sectorID'] || optv['sectorID'];
                                let sectorErrors = argv['sectorError'] || optv['sectorError'];
                                let suppData = argv['suppData'] || optv['suppData'];
                                if (suppData) suppData = readFile(path.join(rootDir, suppData));
                                let diArchive, command, name = path.basename(sArchiveFile);
                                if (sArchiveFile.endsWith('/')) {
                                    command = "--dir " + name;
                                    diArchive = readDir(sArchiveFile);
                                } else {
                                    command = "--disk " + name;
                                    diArchive = readDisk(sArchiveFile, false, sectorIDs, sectorErrors, suppData);
                                }
                                if (diArchive) {
                                    let sTempJSON = name;
                                    let i = sTempJSON.indexOf(".");
                                    if (i > 0) sTempJSON = sTempJSON.substr(0, i);
                                    sTempJSON += ".json";
                                    diArchive.setArgs(sprintf("%s --output %s%s", command, sTempJSON, diskette.options));
                                    writeDisk(sTempJSON, diArchive, false, 0, true);
                                    let warning = false;
                                    if (sArchiveFile.endsWith(".img")) {
                                        let json = diArchive.getJSON();
                                        diArchive.buildDiskFromJSON(json);
                                        let sTempIMG = sTempJSON.replace(".json",".img");
                                        writeDisk(sTempIMG, diArchive, false, 0, true);
                                        if (!compareDisks(sTempIMG, sArchiveFile)) {
                                            printf("warning: %s unsuccessfully rebuilt\n", sArchiveFile);
                                            warning = true;
                                        } else {
                                            fs.unlinkSync(sTempIMG);
                                        }
                                    }
                                    if (!warning) {
                                        if (argv['rebuild']) {
                                            fs.renameSync(sTempJSON, sFile);
                                        } else {
                                            fs.unlinkSync(sTempJSON);
                                        }
                                    }
                                }
                            }
                        }
                    }

                    /*
                     * Task #4: Create manifests that can used to evaluate the contents of the entire collection.
                     */
                    if (argv['checkmanifests']) {
                        let manifest = di.getFileManifest(getHash);
                        if (argv['readall'] == "md5") {
                            manifest.forEach(function readAllFiles(file) {
                                if (file['md5']) {
                                    printf("%s  %-12s  %s  %s:%s:%s\n", file['md5'], file.name, file.date, diskette.path, file.path);
                                }
                            });
                        }
                        else if (argv['verbose']) {
                            printf("manifest for %s: %2j\n", diskette.path, manifest);
                        } else {
                            printf("manifest for %s contains %d file(s)\n", diskette.path, manifest.length);
                        }
                        cFiles += manifest.length;
                        cManifests++;
                    }
                });
            }
            cConfigs++;
        });
        printf("%d config(s), %d manifest(s), %d files(s)\n", cConfigs, cManifests, cFiles);
        return;
    }

    printf("nothing to do\n");
}

main(...stdlib.getArgs());
