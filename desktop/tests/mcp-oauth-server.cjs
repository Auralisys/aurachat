// OAuth + MCP fixture. Bound to loopback; no real account, service or browser profile.
const http = require('node:http');
const {createHash} = require('node:crypto');
const assert = require('node:assert/strict');
let base, client, authorization, refresh = 'fixture-refresh-0', access = 'fixture-access-0', serial = 0;
let rejected = false, transient = false;
const issuedAccess = new Set();
const counts = {registration:0, exchange:0, refresh:0, calls:0};
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, base);
    let body = '';
    for await (const chunk of req) body += chunk;
    const send = (value, status = 200) => res.writeHead(status, {'content-type':'application/json'}).end(JSON.stringify(value));
    const token = () => {
      issuedAccess.add(`Bearer ${access}`);
      return {access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:3600,scope:'openid offline_access'};
    };
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return send({resource:`${base}/mcp`,authorization_servers:[`${base}/auth/v1`],scopes_supported:['openid']});
    }
    if (url.pathname === '/auth/v1/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/oauth-authorization-server/auth/v1') {
      return send({issuer:`${base}/auth/v1`,authorization_endpoint:`${base}/authorize`,token_endpoint:`${base}/token`,registration_endpoint:`${base}/register`,
        response_types_supported:['code'],code_challenge_methods_supported:['S256'],scopes_supported:['openid','offline_access']});
    }
    if (url.pathname === '/register') {
      assert.equal(req.method,'POST');
      client = JSON.parse(body);
      assert.equal(client.client_name,'AuraChat');
      assert.equal(client.token_endpoint_auth_method,'none');
      assert.deepEqual(client.grant_types,['authorization_code','refresh_token']);
      assert.equal(new URL(client.redirect_uris[0]).hostname,'127.0.0.1');
      counts.registration++;
      return send({client_id:'fixture-client',redirect_uris:client.redirect_uris},201);
    }
    if (url.pathname === '/authorize') {
      assert.equal(url.searchParams.get('client_id'),'fixture-client');
      assert.equal(url.searchParams.get('code_challenge_method'),'S256');
      assert.ok(url.searchParams.get('scope').split(' ').includes('openid'));
      assert.ok(url.searchParams.get('scope').split(' ').includes('offline_access'));
      assert.equal(url.searchParams.get('resource'),`${base}/mcp`);
      assert.equal(url.searchParams.get('redirect_uri'),client.redirect_uris[0]);
      authorization = url.searchParams;
      const callback = new URL(client.redirect_uris[0]);
      callback.searchParams.set('code','fixture-code');
      callback.searchParams.set('state',url.searchParams.get('state'));
      callback.searchParams.set('iss',`${base}/auth/v1`);
      return res.writeHead(302,{location:callback.href}).end();
    }
    if (url.pathname === '/token') {
      assert.equal(req.method,'POST');
      const form = new URLSearchParams(body);
      assert.equal(form.get('client_id'),'fixture-client');
      assert.equal(form.get('resource'),`${base}/mcp`);
      if (form.get('grant_type') === 'authorization_code') {
        assert.equal(form.get('code'),'fixture-code');
        assert.equal(form.get('redirect_uri'),client.redirect_uris[0]);
        assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),authorization.get('code_challenge'));
        counts.exchange++;
      } else {
        assert.equal(form.get('grant_type'),'refresh_token');
        counts.refresh++;
        if (transient) return send({error:'temporarily_unavailable'},503);
        if (rejected || form.get('refresh_token') !== refresh) return send({error:'invalid_grant'},400);
        serial++;
        refresh = `fixture-refresh-${serial}`;access = `fixture-access-${serial}`;
      }
      return send(token());
    }
    if (url.pathname === '/fixture/stats') return send(counts);
    if (url.pathname === '/fixture/revoke') {rejected = true;return send({});}
    if (url.pathname === '/fixture/transient') {transient = !transient;return send({});}
    if (url.pathname !== '/mcp') return send({error:'not_found'},404);
    if (!issuedAccess.has(req.headers.authorization)) {
      return res.writeHead(401,{'www-authenticate':`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`}).end();
    }
    assert.equal(req.headers.cookie,undefined,'OAuth transport must not import browser cookies');
    if (req.method === 'GET') return res.writeHead(405).end();
    if (req.method === 'DELETE') return res.writeHead(200).end();
    const message = JSON.parse(body);
    if (message.id == null) return res.writeHead(202).end();
    let result;
    if (message.method === 'initialize') result = {protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'mobbin-fixture',version:'1'}};
    else if (message.method === 'tools/list') result = {tools:['search_screens','search_flows','search_sections'].map(name => ({name,inputSchema:{type:'object',properties:{}}}))};
    else if (message.method === 'tools/call') {
      counts.calls++;
      result = {content:[{type:'text',text:'Fixture design: red navigation, cover picker.'},{type:'image',mimeType:'image/png',data:pixel}],isError:false};
    } else throw Error(`Unexpected method ${message.method}`);
    res.writeHead(200,{'content-type':'application/json','mcp-session-id':'fixture-session'}).end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
  } catch (error) {
    console.error(error.message);
    res.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({error:'fixture_assertion_failed'}));
  }
});
server.listen(0,'127.0.0.1',() => {base = `http://127.0.0.1:${server.address().port}`;console.log(base);});
