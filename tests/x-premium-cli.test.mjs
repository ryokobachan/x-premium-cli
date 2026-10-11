import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { childEnvironment, billingSummary, enforceSubscriptionOnly, normalizeResponse, requestPayload, extractPosts, readBoundedJson, storagePaths, writeBinaryStream } from '../skills/x-premium-cli/x-premium-cli.mjs';

const valid = {subscription_tier:'XPremium',on_demand_cap_cents:0,on_demand_used_cents:0,prepaid_balance_cents:0,auto_topup_enabled:false,credit_usage_percent:5};

test('child process does not inherit API keys, arbitrary routes, or auth overrides',()=>{
  const env=childEnvironment({HOME:'/real-home',PATH:'/usr/bin',XAI_API_KEY:'secret',ANTHROPIC_API_KEY:'secret2',GROK_CLI_CHAT_PROXY_BASE_URL:'https://evil.invalid',GROK_AUTH_PROVIDER_COMMAND:'bad',GROK_HOME:'/evil',OTEL_LOG_RAW_API_BODIES:'1'});
  assert.equal(env.HOME,'/real-home');
  assert.equal(env.GROK_DISABLE_API_KEY_AUTH,'1');
  assert.equal(env.XAI_API_KEY,undefined); assert.equal(env.ANTHROPIC_API_KEY,undefined);
  assert.equal(env.GROK_CLI_CHAT_PROXY_BASE_URL,undefined); assert.equal(env.GROK_AUTH_PROVIDER_COMMAND,undefined);
  assert.notEqual(env.GROK_HOME,'/evil'); assert.equal(env.OTEL_LOG_RAW_API_BODIES,undefined);
});

test('subscription guard requires paid billing evidence but does not require quota',()=>{
  assert.equal(enforceSubscriptionOnly(valid),true);
  for(const change of [{on_demand_cap_cents:null},{on_demand_cap_cents:100},{prepaid_balance_cents:100},{prepaid_balance_cents:null},{on_demand_used_cents:null},{auto_topup_enabled:true},{auto_topup_enabled:null},{subscription_tier:'Free'},{subscription_tier:'SuperGrok'}]) {
    assert.throws(()=>enforceSubscriptionOnly({...valid,...change}));
  }
  const missing=billingSummary({subscriptionTier:'XPremium'},{config:{}});
  assert.equal(missing.on_demand_cap_cents,null); assert.equal(missing.prepaid_balance_cents,null);
  for(const quota of [undefined,null,-1,100,NaN]) assert.equal(enforceSubscriptionOnly({...valid,credit_usage_percent:quota}),true);
});

test('billing parser rejects invalid cents and identity labels',()=>{
  const s=billingSummary({subscriptionTier:'XPremium\nsecret'},{config:{onDemandCap:{val:-1},onDemandUsed:{val:'0'},prepaidBalance:{val:0},creditUsagePercent:NaN}});
  assert.equal(s.subscription_tier,null);assert.equal(s.on_demand_cap_cents,null);assert.equal(s.on_demand_used_cents,null);assert.equal(s.credit_usage_percent,null);
});

test('period-only unified response preserves unknown quota without blocking subscription access',()=>{
  const s=billingSummary({subscriptionTier:'XPremium'},{config:{
    currentPeriod:{type:'USAGE_PERIOD_TYPE_WEEKLY',start:'2025-01-01T00:00:00Z',end:'2025-01-08T00:00:00Z'},
    onDemandCap:{},onDemandUsed:{},prepaidBalance:{},isUnifiedBillingUser:true,
  }},{rule:{enabled:false}});
  assert.equal(s.credit_usage_percent,null);
  assert.equal(enforceSubscriptionOnly(s),true);
});

test('CLI submits without quota confirmation and stops on provider limits or unsafe paid billing',async t=>{
  const home=await mkdtemp(path.join(tmpdir(),'x-premium-quota-optional-'));
  const paths=storagePaths(home),log=path.join(home,'requests.json'),mock=path.join(home,'mock-fetch.mjs');
  const helper=fileURLToPath(new URL('../skills/x-premium-cli/x-premium-cli.mjs',import.meta.url));
  await mkdir(paths.auth_home,{recursive:true,mode:0o700});
  await writeFile(path.join(paths.auth_home,'auth.json'),JSON.stringify({
    'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828':{
      auth_mode:'oidc',oidc_issuer:'https://auth.x.ai',oidc_client_id:'b1a00492-073a-47ea-816f-4c329264a828',
      key:'test-only-oauth-access',refresh_token:'test-only-oauth-refresh',user_id:'test-account',
      expires_at:new Date(Date.now()+86400000).toISOString(),principal_type:'Personal',
    },
  }),{mode:0o600});
  await writeFile(mock,String.raw`
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
const calls=[],scenario=process.env.X_PREMIUM_TEST_SCENARIO;
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
globalThis.fetch=async (url,options)=>{
  const parsed=new URL(url);assert.equal(parsed.origin,'https://cli-chat-proxy.grok.com');
  assert.equal(options.headers.Authorization,'Bearer test-only-oauth-access');
  calls.push({method:options.method,path:parsed.pathname});writeFileSync(process.env.X_PREMIUM_TEST_LOG,JSON.stringify(calls));
  if(options.method==='POST') {
    assert.equal(parsed.pathname,'/v1/responses');
    if(scenario==='exhausted')return json({error:'subscription limit reached'},429);
    const payload=JSON.parse(options.body),tool=payload.tools[0]?.type;
    const output=[{type:'message',content:[{type:'output_text',text:'Mock response'}]}];
    if(tool==='x_search')output.unshift({type:'custom_tool_call',call_id:'xs_test',status:'completed'});
    if(tool==='web_search')output.unshift({type:'web_search_call',status:'completed'});
    return json({model:payload.model,output});
  }
  assert.equal(options.method,'GET');
  if(parsed.pathname==='/v1/user')return json({userId:'test-account',subscriptionTier:'XPremium'});
  if(parsed.pathname==='/v1/billing')return json({config:{onDemandCap:scenario==='paid'?{val:100}:{},onDemandUsed:{},prepaidBalance:{},...(scenario==='exhausted'?{creditUsagePercent:100}:{})}});
  if(parsed.pathname==='/v1/auto-topup-rule')return json({});
  if(parsed.pathname==='/v1/models')return json({data:[{id:'grok-4.7'}]});
  throw new Error('Unexpected route');
};
`);
  try {
    for(const [scenario,mode] of [['missing','chat'],['missing','x-search'],['missing','web-search'],['exhausted','x-search'],['paid','x-search']]) {
      await t.test(`${scenario}: ${mode}`,async()=>{
        const result=spawnSync(process.execPath,['--import',mock,helper,mode,'Test query'],{
          env:{HOME:home,PATH:process.env.PATH,X_PREMIUM_TEST_SCENARIO:scenario,X_PREMIUM_TEST_LOG:log},encoding:'utf8',timeout:10000,
        });
        assert.equal(result.status,scenario==='missing'?0:1,result.stderr);
        const data=JSON.parse(result.stdout),calls=JSON.parse(await readFile(log,'utf8'));
        assert.equal(calls.filter(c=>c.method==='POST').length,scenario==='paid'?0:1);
        if(scenario==='missing') {
          assert.equal(data.ok,true);assert.equal(data.billing_before.credit_usage_percent,null);
          assert.equal(data.billing_before.subscription_only_guard,'PASS');assert.equal(data.search_execution_verified,true);
          assert.equal(data.paid_usage_unchanged,true);assert.equal(data.further_requests_allowed,true);
        } else {
          assert.equal(data.ok,false);
          assert.equal(data.code,scenario==='paid'?'ZERO_ON_DEMAND_CAP_UNCONFIRMED':'SUBSCRIPTION_HTTP_429');
          if(scenario==='exhausted')assert.equal(data.further_requests_allowed,false);
        }
        assert.ok(!result.stdout.includes('test-only-oauth'));
        await assert.rejects(access(path.join(paths.data_home,'quota')),{code:'ENOENT'});
        await assert.rejects(access(paths.cache_home),{code:'ENOENT'});
      });
    }
  } finally {await rm(home,{recursive:true,force:true});}
});

test('official proto3 zero representations differ from missing billing evidence',()=>{
  const b={config:{onDemandCap:{},onDemandUsed:{},prepaidBalance:{},creditUsagePercent:1}};
  const s=billingSummary({subscriptionTier:'XPremium'},b,{rule:{topupAmount:{val:500}}});
  assert.equal(enforceSubscriptionOnly(s),true);
  assert.equal(billingSummary({},b,{}).auto_topup_enabled,false);
  assert.equal(billingSummary({},b,{unknown:true}).auto_topup_enabled,null);
  assert.equal(billingSummary({},b,{rule:{enabled:true}}).auto_topup_enabled,true);
});

test('Responses normalization excludes reasoning and raw tool inputs',()=>{
  const data={model:'grok-4.7',output:[{type:'reasoning',text:'private reasoning'},
    {type:'custom_tool_call',call_id:'xs_1',status:'completed',input:'secret'},
    {type:'custom_tool_call',call_id:'as_1',status:'completed'},
    {type:'message',content:[{type:'output_text',text:'answer',annotations:[{type:'url_citation',url:'https://x.com/example/status/1'}]}]}],
    usage:{server_side_tool_usage_details:{x_posts_fetched:3,x_users_fetched:0}}};
  const r=normalizeResponse(data);
  assert.equal(r.answer,'answer');assert.equal(r.tools.length,1);assert.equal(r.x_posts_fetched,3);
  assert.equal(r.resolved_model,'grok-4.7');assert.equal(r.citations.length,1);
  assert.equal(JSON.stringify(r).includes('secret'),false);assert.equal(JSON.stringify(r).includes('private reasoning'),false);
  assert.throws(()=>normalizeResponse({error:'token is secret'}),{code:'RESPONSE_OUTPUT_UNRECOGNIZED'});
});

test('requests expose only the selected server-side tool and disable response storage',()=>{
  assert.deepEqual(requestPayload('chat','query','grok-4.7').tools,[]);
  const x=requestPayload('x-search','query','grok-4.7');
  assert.deepEqual(x.tools,[{type:'x_search'}]);assert.equal(x.store,false);
  assert.deepEqual(requestPayload('web-search','query','grok-4.7').tools,[{type:'web_search'}]);
  assert.throws(()=>requestPayload('shell','query','grok-4.7'));
});

test('post timestamps are derived and not represented as independently verified',()=>{
  const ms=Date.UTC(2025,0,3,12,34,56);const id=((BigInt(ms)-1288834974657n)<<22n)+7n;
  const url=`https://x.com/OpenAIDevs/status/${id}`;
  const p=extractPosts(`${url} ${url} https://evil.invalid/status/${id}`);
  assert.equal(p.length,1);assert.equal(p[0].posted_at_utc,new Date(ms).toISOString());assert.equal(p[0].existence_verified,false);
  assert.equal(p[0].date_source,'post_id_snowflake_derived');
});

test('response reader bounds bytes while streaming',async()=>{
  const response=new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"a":"'));c.enqueue(new Uint8Array(40));c.close();}}));
  await assert.rejects(readBoundedJson(response,16),{code:'RESPONSE_TOO_LARGE'});
  assert.deepEqual(await readBoundedJson(new Response('{"a":1}'),100),{a:1});
});

test('binary download rejects truncation, excess size and changed bytes',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'grok-stream-'));
  const bytes=Buffer.from('trusted binary'),hash=createHash('sha256').update(bytes).digest('hex');
  const body=value=>(async function*(){yield value.subarray(0,4);yield value.subarray(4);})();
  try {
    await writeBinaryStream(body(bytes),path.join(dir,'valid'),bytes.length,hash);
    assert.deepEqual(await readFile(path.join(dir,'valid')),bytes);
    await assert.rejects(writeBinaryStream(body(bytes),path.join(dir,'short'),bytes.length+1,hash),{code:'OFFICIAL_BINARY_SIZE_MISMATCH'});
    await assert.rejects(writeBinaryStream(body(bytes),path.join(dir,'long'),bytes.length-1,hash),{code:'OFFICIAL_BINARY_SIZE_MISMATCH'});
    await assert.rejects(writeBinaryStream(body(bytes),path.join(dir,'changed'),bytes.length,'0'.repeat(64)),{code:'OFFICIAL_BINARY_CHANGED'});
    await assert.rejects(writeBinaryStream(body(bytes),path.join(dir,'valid'),bytes.length,hash),{code:'EEXIST'});
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('relocated source uses the current home and never fetches or writes on unauthenticated search',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'grok portable '));
  const home=path.join(dir,'new home'),source=path.join(dir,'relocated skill');
  await mkdir(home);await mkdir(source);
  const script=path.join(source,'x-premium-cli.mjs');
  await copyFile(fileURLToPath(new URL('../skills/x-premium-cli/x-premium-cli.mjs',import.meta.url)),script);
  const run=mode=>spawnSync(process.execPath,[script,mode,'test query'],{cwd:home,env:{HOME:home,PATH:process.env.PATH},encoding:'utf8',timeout:10000});
  try {
    const paths=run('paths');assert.equal(paths.status,0);
    const actual=JSON.parse(paths.stdout);delete actual.ok;
    assert.deepEqual(actual,storagePaths(home));
    const shortcut=path.join(home,'linked-helper.mjs');await symlink(script,shortcut);
    const linked=spawnSync(process.execPath,[shortcut,'paths'],{env:{HOME:home,PATH:process.env.PATH},encoding:'utf8',timeout:10000});
    assert.equal(linked.status,0);assert.equal(JSON.parse(linked.stdout).auth_home,actual.auth_home);
    assert.throws(()=>storagePaths('relative-home'),{code:'ABSOLUTE_HOME_REQUIRED'});
    for(const mode of ['status','x-search']) {
      const result=run(mode);assert.equal(result.status,1);
      assert.deepEqual(JSON.parse(result.stdout),{ok:false,code:'LOGIN_REQUIRED'});
    }
    await assert.rejects(access(path.join(home,'.cache')),{code:'ENOENT'});
    await assert.rejects(access(path.join(home,'.local')),{code:'ENOENT'});
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('setup refuses an unsafe existing cache instead of downloading a replacement', {skip:process.platform!=='darwin'||process.arch!=='arm64'},async()=>{
  const home=await mkdtemp(path.join(tmpdir(),'grok-cache-'));
  const paths=storagePaths(home);
  try {
    await mkdir(paths.cache_home,{recursive:true,mode:0o700});
    await writeFile(paths.official_binary,'untrusted',{mode:0o500});
    const script=fileURLToPath(new URL('../skills/x-premium-cli/x-premium-cli.mjs',import.meta.url));
    const result=spawnSync(process.execPath,[script,'setup'],{env:{HOME:home,PATH:process.env.PATH},encoding:'utf8',timeout:10000});
    assert.equal(result.status,1);assert.deepEqual(JSON.parse(result.stdout),{ok:false,code:'UNSAFE_OFFICIAL_BINARY'});
    assert.equal(await readFile(paths.official_binary,'utf8'),'untrusted');
  } finally { await rm(home,{recursive:true,force:true}); }
});
