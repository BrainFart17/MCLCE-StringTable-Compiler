#!/usr/bin/env node
/**
 * StringTable Binary Builder
 * 
 * Produces binary files compatible with the C++ StringTable reader.
 * (Original header/comments fully preserved)
 */

const fs   = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');

// ---------------------------------------------------------------------------
// ------------------------- ORIGINAL CODE START ------------------------------
// ---------------------------------------------------------------------------

// ---------------- Buffer Helpers ----------------

function writeInt(buf, offset, value) {
  buf.writeInt32BE(value, offset);
  return offset + 4;
}

function writeBoolean(buf, offset, value) {
  buf.writeUInt8(value ? 1 : 0, offset);
  return offset + 1;
}

function javaUTFBytes(str) {
  const parts = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 0x0000) {
      parts.push(Buffer.from([0xC0, 0x80]));
    } else if (code <= 0x007F) {
      parts.push(Buffer.from([code]));
    } else if (code <= 0x07FF) {
      parts.push(Buffer.from([
        0xC0 | (code >> 6),
        0x80 | (code & 0x3F)
      ]));
    } else if (code >= 0xD800 && code <= 0xDBFF) {
      const hi = code;
      const lo = str.charCodeAt(++i);
      parts.push(Buffer.from([
        0xE0 | (hi >> 12), 0x80 | ((hi >> 6) & 0x3F), 0x80 | (hi & 0x3F),
        0xE0 | (lo >> 12), 0x80 | ((lo >> 6) & 0x3F), 0x80 | (lo & 0x3F)
      ]));
    } else {
      parts.push(Buffer.from([
        0xE0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3F),
        0x80 | (code & 0x3F)
      ]));
    }
  }
  return Buffer.concat(parts);
}

function writeUTF(str) {
  const encoded = javaUTFBytes(str);
  if (encoded.length > 65535) throw new Error(`String too long for UTF encoding: ${str.substring(0,40)}...`);
  const out = Buffer.allocUnsafe(2 + encoded.length);
  out.writeUInt16BE(encoded.length, 0);
  encoded.copy(out, 2);
  return out;
}

// ---------------- XML Parser ----------------

function parseXmlStrings(xmlStr) {
  const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
  const result = {};
  const dataNodes = doc.getElementsByTagName('data');
  for (let i = 0; i < dataNodes.length; i++) {
    const node = dataNodes[i];
    const name = node.getAttribute('name');
    const valueNodes = node.getElementsByTagName('value');
    if (name && valueNodes.length > 0) {
      result[name] = valueNodes[0].textContent || '';
    }
  }
  return result;
}

// ---------------- Language Blob Builder ----------------

function buildLanguageBlob(langId, strings, keyOrder = null, langVersion = 1) {
  const order = keyOrder ?? Object.keys(strings);
  const parts = [];

  const vBuf = Buffer.allocUnsafe(4);
  vBuf.writeInt32BE(langVersion, 0);
  parts.push(vBuf);

  if (langVersion > 0) {
    parts.push(Buffer.from([1]));
  }

  parts.push(writeUTF(langId));

  const countBuf = Buffer.allocUnsafe(4);
  countBuf.writeInt32BE(order.length, 0);
  parts.push(countBuf);

  let missing = 0;
  for (const key of order) {
    const value = strings[key];
    if (value === undefined) missing++;
    parts.push(writeUTF(value !== undefined ? String(value) : ''));
  }

  if (missing > 0) {
    process.stderr.write(
      `  Warning [${langId}]: ${missing} key(s) missing, written as empty string.\n`
    );
  }

  return { buf: Buffer.concat(parts), keyOrder: order };
}

// ---------------- Top-Level File Builder ----------------

function buildStringTableFile(languages, fileVersion = 1) {
  const baseBlob = buildLanguageBlob(
    languages[0].langId,
    languages[0].strings,
    null,
    languages[0].langVersion ?? 1
  );
  const keyOrder = baseBlob.keyOrder;

  const blobs = [
    baseBlob.buf,
    ...languages.slice(1).map(({ langId, strings, langVersion }) =>
      buildLanguageBlob(langId, strings, keyOrder, langVersion ?? 1).buf
    )
  ];

  const parts = [];

  const fvBuf = Buffer.allocUnsafe(4);
  fvBuf.writeInt32BE(fileVersion, 0);
  parts.push(fvBuf);

  const lcBuf = Buffer.allocUnsafe(4);
  lcBuf.writeInt32BE(languages.length, 0);
  parts.push(lcBuf);

  for (let i = 0; i < languages.length; i++) {
    parts.push(writeUTF(languages[i].langId));
    const szBuf = Buffer.allocUnsafe(4);
    szBuf.writeInt32BE(blobs[i].length, 0);
    parts.push(szBuf);
  }

  for (const blob of blobs) {
    parts.push(blob);
  }

  return { buf: Buffer.concat(parts), keyOrder };
}

// ---------------- Folder Loader ----------------

function loadLanguagesFromFolder(rootDir, baseLangId = 'en-EN') {
  if (!fs.existsSync(rootDir)) {
    console.error(`Folder not found: ${rootDir}`);
    process.exit(1);
  }
  if (!fs.statSync(rootDir).isDirectory()) {
    console.error(`Not a directory: ${rootDir}`);
    process.exit(1);
  }

  function mergeXmlsInDir(dir) {
    const xmlFiles = fs.readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith('.xml'))
      .sort();
    if (xmlFiles.length === 0) return null;

    const merged = {};
    for (const filename of xmlFiles) {
      const xmlFile = path.join(dir, filename);
      const strings = parseXmlStrings(fs.readFileSync(xmlFile, 'utf8'));
      Object.assign(merged, strings);
    }
    return { merged, count: Object.keys(merged).length, fileCount: xmlFiles.length };
  }

  const languages = [];
  const baseResult = mergeXmlsInDir(rootDir);
  if (baseResult) {
    console.log(`  ${baseLangId.padEnd(20)}: ${baseResult.count} strings from ${baseResult.fileCount} file(s) in ${rootDir}`);
    languages.push({ langId: baseLangId, strings: baseResult.merged });
  } else {
    console.warn(`  Warning: no XML files found in root dir (${rootDir}), skipping base language.`);
  }

  const subdirs = fs.readdirSync(rootDir)
    .filter(entry => fs.statSync(path.join(rootDir, entry)).isDirectory())
    .sort();

  for (const subdir of subdirs) {
    const langId  = subdir;
    const fullDir = path.join(rootDir, subdir);
    const result  = mergeXmlsInDir(fullDir);
    if (!result) {
      console.warn(`  Warning: no XML files in ${fullDir}, skipping.`);
      continue;
    }
    console.log(`  ${langId.padEnd(20)}: ${result.count} strings from ${result.fileCount} file(s) in ${fullDir}`);
    languages.push({ langId, strings: result.merged });
  }

  if (languages.length === 0) {
    console.error('No languages found — make sure the root folder contains XML files and/or language subfolders.');
    process.exit(1);
  }

  return languages;
}

// ---------------- Strings.h Generator ----------------

function generateStringsH(baseLangId, keyOrder) {
  const lines = [
    '#pragma once',
    `// Auto-generated by StringTable builder — do not edit manually.`,
    `// Source language: ${baseLangId}`,
    `// Total strings:   ${keyOrder.length}`,
    '',
  ];

  const maxLen = keyOrder.reduce((m, k) => Math.max(m, k.length), 0);

  keyOrder.forEach((key, idx) => {
    lines.push(`#define ${key.padEnd(maxLen)}  ${idx}`);
  });

  lines.push('');
  return lines.join('\n');
}

// ---------------- Example & Build ----------------

function runExample() {
  const enStrings = {
    IDS_NOFREESPACE_TEXT: "Your system storage doesn't have enough free space to create a game save.",
    IDS_OK:    'OK',
    IDS_CANCEL:'Cancel',
  };
  const frStrings = {
    IDS_NOFREESPACE_TEXT: "Votre stockage système n'a pas assez d'espace libre pour créer une sauvegarde.",
    IDS_OK:    'OK',
    IDS_CANCEL:'Annuler',
  };

  const languages = [
    { langId: 'en-US', strings: enStrings },
    { langId: 'fr-FR', strings: frStrings },
  ];

  const { buf } = buildStringTableFile(languages);
  const outFile = 'example_strings.bin';
  fs.writeFileSync(outFile, buf);
  console.log(`Written ${buf.length} bytes to ${outFile}`);
}

function runBuild(args) {
  if (args.length < 2) { printUsage(); process.exit(1); }
  const outFile = args[0];
  const rest    = args.slice(1);

  let languages;

  const folderIdx = rest.indexOf('--folder');
  if (folderIdx !== -1) {
    const dir = rest[folderIdx + 1];
    const baseLangIdx = rest.indexOf('--base-lang');
    const baseLang    = baseLangIdx !== -1 ? rest[baseLangIdx + 1] : 'en-US';
    console.log(`Loading languages from folder: ${dir}  (base language: ${baseLang})`);
    languages = loadLanguagesFromFolder(dir, baseLang);
  } else {
    languages = rest.map(arg => {
      const colonIdx = arg.indexOf(':');
      if (colonIdx === -1) {
        console.error(`Invalid language argument: ${arg}`);
        process.exit(1);
      }
      const langId  = arg.substring(0, colonIdx);
      const xmlFile = arg.substring(colonIdx + 1);
      const strings = parseXmlStrings(fs.readFileSync(xmlFile, 'utf8'));
      console.log(`  ${langId.padEnd(20)}: ${Object.keys(strings).length} strings  <- ${xmlFile}`);
      return { langId, strings };
    });
  }

  const { buf, keyOrder } = buildStringTableFile(languages);
  fs.writeFileSync(outFile, buf);
  console.log(`\nWritten ${buf.length} bytes to ${outFile}  (${languages.length} language(s))`);

  const stringsHPath = 'strings.h';
  const header = generateStringsH(languages[0].langId, keyOrder);
  fs.writeFileSync(stringsHPath, header, 'utf8');
  console.log(`Written ${keyOrder.length} #define(s) to ${stringsHPath}`);
}

// ---------------- CLI Helpers ----------------

function printUsage() {
  console.log(`
StringTable Binary Builder
==========================
Usage:
  node index.js build <output.bin> <lang1:input1.xml> [lang2:input2.xml ...]
  node index.js build <output.bin> --folder <dir>
  node index.js example
  node index.js extract <strings.loc> [outDir]
  node index.js restore <strings.h> <strings.loc> [outDir]
`);
}

// ---------------------------------------------------------------------------
// ------------------------- NEW ADDITIONS START -----------------------------
// ---------------------------------------------------------------------------

// ---------- Binary Reader ----------
function readInt(buf, offsetObj) { const v = buf.readInt32BE(offsetObj.offset); offsetObj.offset += 4; return v; }
function readBoolean(buf, offsetObj) { const v = buf.readUInt8(offsetObj.offset) !== 0; offsetObj.offset += 1; return v; }
function readUTF(buf, offsetObj) { const len = buf.readUInt16BE(offsetObj.offset); offsetObj.offset += 2; const slice = buf.slice(offsetObj.offset, offsetObj.offset + len); offsetObj.offset += len; return slice.toString('utf8'); }

function parseLanguageBlob(buf) {
  const offsetObj = { offset: 0 };
  const langVersion = readInt(buf, offsetObj);
  let isStatic = false;
  if (langVersion > 0) isStatic = readBoolean(buf, offsetObj);
  const langId = readUTF(buf, offsetObj);
  const totalStrings = readInt(buf, offsetObj);
  const strings = [];
  if (isStatic) {
    for (let i = 0; i < totalStrings; i++) strings.push(readUTF(buf, offsetObj));
  } else {
    for (let i = 0; i < totalStrings; i++) {
      const key = readUTF(buf, offsetObj);
      const value = readUTF(buf, offsetObj);
      strings.push({ key, value });
    }
  }
  return { langId, isStatic, strings };
}

function parseStringTableFile(buf) {
  const offsetObj = { offset: 0 };
  const version = readInt(buf, offsetObj);
  const langCount = readInt(buf, offsetObj);
  const directory = [];
  for (let i = 0; i < langCount; i++) {
    const langId = readUTF(buf, offsetObj);
    const size = readInt(buf, offsetObj);
    directory.push({ langId, size });
  }
  const languages = [];
  for (const entry of directory) {
    const blob = buf.slice(offsetObj.offset, offsetObj.offset + entry.size);
    offsetObj.offset += entry.size;
    languages.push(parseLanguageBlob(blob));
  }
  return { version, languages };
}

// ---------- XML Builder ----------
function escapeXml(str) { return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function buildXml(strings, keyOrder=null) {
  let xml = '<?xml version="1.0" encoding="utf-8"?>\n<root>\n';
  if (Array.isArray(strings) && typeof strings[0]==='string') {
    for (let i=0;i<strings.length;i++) {
      const key = keyOrder ? keyOrder[i] : `STRING_${i}`;
      xml += `  <data name="${key}"><value>${escapeXml(strings[i])}</value></data>\n`;
    }
  } else {
    for (const { key,value } of strings) {
      xml += `  <data name="${key}"><value>${escapeXml(value)}</value></data>\n`;
    }
  }
  xml += '</root>\n';
  return xml;
}

// ---------- Extract (.loc) ----------
function runExtract(args) {
  const input = args[0];
  const outDir = args[1] || "extracted";
  const buf = fs.readFileSync(input);
  const { languages } = parseStringTableFile(buf);
  fs.mkdirSync(outDir, { recursive: true });
  let keyOrder = null;
  languages.forEach((lang,index)=>{
    const dir = path.join(outDir, lang.langId);
    fs.mkdirSync(dir, { recursive: true });
    if (index===0 && lang.isStatic) keyOrder = lang.strings.map((_,i)=>`STRING_${i}`);
    fs.writeFileSync(path.join(dir,"strings.xml"), buildXml(lang.strings,keyOrder),'utf8');
  });
}

// ---------- Restore (.h + .loc) ----------
function parseStringsH(filePath) {
  const lines = fs.readFileSync(filePath,'utf8').split(/\r?\n/);
  const map = [];
  for (const line of lines) {
    const m = line.match(/^#define\s+(\S+)\s+(\d+)/);
    if (!m) continue;
    map[parseInt(m[2])] = m[1];
  }
  return map;
}

function runRestore(args) {
  const hFile = args[0];
  const locFile = args[1];
  const outDir = args[2] || "restored";
  const keyOrder = parseStringsH(hFile);
  const buf = fs.readFileSync(locFile);
  const { languages } = parseStringTableFile(buf);
  fs.mkdirSync(outDir,{recursive:true});
  languages.forEach(lang=>{
    var dir;
    if (lang.langId == "en-US") {
	dir = outDir
    }
    else {
	dir = path.join(outDir, lang.langId);
    }
    fs.mkdirSync(dir,{recursive:true});
    let xml = '<?xml version="1.0" encoding="utf-8"?>\n<root>\n';
    if(lang.isStatic){
      for(let i=0;i<lang.strings.length;i++){
        const key = keyOrder[i] || `UNKNOWN_${i}`;
        xml += `  <data name="${key}"><value>${escapeXml(lang.strings[i])}</value></data>\n`;
      }
    } else {
      for(const {key,value} of lang.strings){
        xml += `  <data name="${key}"><value>${escapeXml(value)}</value></data>\n`;
      }
    }
    xml += '</root>\n';
    fs.writeFileSync(path.join(dir,"strings.xml"),xml,'utf8');
  });
}

// ---------------------------------------------------------------------------
// ------------------------- CLI -----------------------------
// ---------------------------------------------------------------------------

const [,, cmd, ...rest] = process.argv;
switch(cmd){
  case 'build':   runBuild(rest);   break;
  case 'extract': runExtract(rest); break;
  case 'restore': runRestore(rest); break;
  case 'example': runExample();     break;
  default:        printUsage();     break;
}
