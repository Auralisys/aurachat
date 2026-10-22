// Offline stdio fixture: no external service calls, login or credentials.
const readline = require('node:readline');
let initialized = false;
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
    result = {content:[{type:'text',text:`Fixture record: ${request.params.arguments.id}`}],isError:request.params.arguments.id === 'error'};
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
