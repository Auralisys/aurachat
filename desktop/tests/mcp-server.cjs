// Offline stdio fixture: no external service calls, login or credentials.
const readline = require('node:readline');
let initialized = false;
function largePreview() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(512,0);header.writeUInt32BE(256,4);header[8]=8;header[9]=2;
  const pixels = require('node:crypto').randomBytes((512*3+1)*256);
  for (let row = 0; row < 256; row++) pixels[row*(512*3+1)] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),
    chunk('IDAT',require('node:zlib').deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
function respond(request) {
  if (request.method === 'notifications/initialized') {initialized = true;return null;}
  if (request.id == null) return null;
  let result;
  if (request.method === 'initialize') {
    result = {protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
  } else if (!initialized) {
    return {jsonrpc:'2.0',id:request.id,error:{code:-32600,message:'Not initialized'}};
  } else if (request.method === 'tools/list') {
    const second = request.params?.cursor === 'next';
    result = {tools:[{name:second ? 'fixture_other' : 'lookup_record',description:'Offline fixture',inputSchema:{type:'object',properties:{id:{type:'string'}}}}],...(second ? {} : {nextCursor:'next'})};
  } else if (request.method === 'tools/call') {
    const id = request.params.arguments.id;
    const content = [{type:'text',text:`Fixture record: ${id}`}];
    // 1x1 PNG, like a browser screenshot tool result.
    if (id === 'screenshot') content.push({type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='});
    if (id === 'large-screenshot') content.push({type:'image',mimeType:'image/png',data:largePreview()});
    result = {content,isError:id === 'error'};
  } else {
    return {jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Unsupported method'}};
  }
  return {jsonrpc:'2.0',id:request.id,result};
}
if (process.argv.includes('--http')) {
  const server = require('node:http').createServer((req,res) => {
    if (req.url === '/docs') {
      require('node:assert/strict').equal(req.method,'GET');
      require('node:assert/strict').equal(req.headers.cookie,undefined);
      require('node:assert/strict').equal(req.headers.authorization,undefined);
      res.writeHead(200,{'content-type':'text/plain; charset=utf-8'}).end('é'.repeat(4000));return;
    }
    if (req.url === '/redirect') {res.writeHead(302,{location:'http://127.0.0.1:1/not-followed'}).end();return;}
    if (req.url === '/binary') {res.writeHead(200,{'content-type':'application/octet-stream'}).end('binary');return;}
    if (req.headers.authorization !== 'Bearer fixture-token') {res.writeHead(401).end();return;}
    if (req.method === 'GET') {res.writeHead(405).end();return;}
    if (req.method === 'DELETE') {res.writeHead(200).end();return;}
    let bytes = '';
    req.on('data',data=>bytes+=data);
    req.on('end',()=>{
      const result = respond(JSON.parse(bytes));
      if (!result) {res.writeHead(202).end();return;}
      res.writeHead(200,{'content-type':'application/json','mcp-session-id':'fixture-session'});
      res.end(JSON.stringify(result));
    });
  });
  server.listen(0,'127.0.0.1',()=>console.log(server.address().port));
} else {
  readline.createInterface({input:process.stdin}).on('line',line=>{
    const result = respond(JSON.parse(line));
    if (result) process.stdout.write(JSON.stringify(result)+'\n');
  });
}
