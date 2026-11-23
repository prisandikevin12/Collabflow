import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Synthetic Auth/PostgREST boundary. Actual role/RLS assertions live in
// inbox-database.test.mjs; this tests cookies, rendering, routing and caching.
test("production creator inbox HTTP responses remain private", { timeout: 90000 }, async t => {
  assert.equal(existsSync(new URL("../../.env.local", import.meta.url)),false,"Use an isolated source copy without environment files");
  const a="11111111-1111-4111-8111-111111111111", b="22222222-2222-4222-8222-222222222222", c="33333333-3333-4333-8333-333333333333";
  const id="aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
  const content={id,sender_name:"Private Sender A",sender_email:"sender-a@example.test",company:"Private Brand A",message:"<script>Never execute me</script>\nFull private proposal",created_at:"2026-11-20T06:00:00.123456+00:00"};
  let mode="normal"; const rpcCalls=[];
  let refreshSucceeds=false, refreshCalls=0;
  const user=uid=>({id:uid,aud:"authenticated",role:"authenticated",email:"creator@example.test",app_metadata:{provider:"email"},user_metadata:{},created_at:"2026-01-01T00:00:00Z"});
  const sessions=new Map();
  function cookie(uid,expired=false){
    const exp=Math.floor(Date.now()/1000)+(expired?-3600:3600);
    const encode=v=>Buffer.from(JSON.stringify(v)).toString("base64url");
    const base=`${encode({alg:"HS256",typ:"JWT"})}.${encode({sub:uid,aud:"authenticated",role:"authenticated",exp})}`;
    const token=base+"."+createHmac("sha256","local-inbox-fixture-only").update(base).digest("base64url");
    if(!expired)sessions.set(token,uid);
    return "sb-127-auth-token=base64-"+encode({access_token:token,refresh_token:"local-fixture-refresh",expires_at:exp,expires_in:3600,token_type:"bearer",user:user(uid)});
  }
  const aCookie=cookie(a),bCookie=cookie(b),cCookie=cookie(c),expiredCookie=cookie(a,true);
  const fixture=createServer(async(req,res)=>{
    const path=new URL(req.url,"http://localhost").pathname;
    const uid=sessions.get((req.headers.authorization??"").replace(/^Bearer /,""));
    res.setHeader("content-type","application/json");res.setHeader("cache-control","no-store");
    const send=(status,data)=>{res.writeHead(status);res.end(JSON.stringify(data));};
    if(path==="/auth/v1/user")return uid?send(200,user(uid)):send(401,{message:"Invalid fixture session"});
    if(path==="/auth/v1/token"){
      refreshCalls++;
      if(!refreshSucceeds)return send(400,{error_code:"refresh_token_not_found",msg:"Expired fixture"});
      const renewed=cookie(a).split("base64-")[1];
      return send(200,JSON.parse(Buffer.from(renewed,"base64url").toString("utf8")));
    }
    if(path==="/rest/v1/creator_public_profiles")return send(200,[{public_id:id,slug:"fixture-creator",display_name:"Public Creator",bio:null}]);
    if(!uid)return send(401,{code:"PGRST301",message:"No fixture session"});
    if(path==="/rest/v1/creator_profiles")return send(200,uid===c?null:{user_id:uid,display_name:"Creator",slug:"fixture-creator",bio:null,is_public:false});
    if(path.startsWith("/rest/v1/rpc/")){
      let body="";for await(const part of req)body+=part;
      const args=JSON.parse(body||"{}");rpcCalls.push({path,uid,args});
      if(mode==="error")return send(500,{message:"PRIVATE-UPSTREAM-ERROR sender-a@example.test"});
      if(uid!==a||mode==="empty")return send(200,[]);
      if(path.endsWith("list_creator_inquiries")){
        const preview={id,sender_name:content.sender_name,company:content.company,created_at:content.created_at,message_preview:"Preview of proposal"};
        if(args.p_before_id)return send(200,[]);
        return send(200,Array.from({length:21},(_,n)=>({...preview,id:`aaaaaaaa-aaaa-4aaa-8aaa-${String(100-n).padStart(12,"0")}`})));
      }
      if(path.endsWith("get_creator_inquiry"))return send(200,args.p_inquiry_id===id?[content]:[]);
    }
    send(500,{message:"Unexpected fixture request"});
  });
  // Existing auth factories use NEXT_PUBLIC constants, which Next inlines at
  // build time. Match the isolated build's dummy loopback URL; do not alter auth.
  const authPort=Number(process.env.COLLABFLOW_HTTP_AUTH_PORT??"54321");
  assert.ok(Number.isInteger(authPort)&&authPort>0&&authPort<=65535);
  fixture.listen(authPort,"127.0.0.1");await once(fixture,"listening");
  t.after(()=>{fixture.closeAllConnections();fixture.close();});
  const portFinder=createServer();portFinder.listen(0,"127.0.0.1");await once(portFinder,"listening");
  const port=portFinder.address().port;await new Promise(r=>portFinder.close(r));
  const app=spawn(process.execPath,["node_modules/next/dist/bin/next","start","--hostname","127.0.0.1","--port",String(port)],{
    cwd:fileURLToPath(new URL("../../",import.meta.url)),windowsHide:true,stdio:["ignore","pipe","pipe"],
    env:{...process.env,INQUIRIES_ENABLED:"false",INQUIRY_DATABASE_URL:"",TURNSTILE_SECRET_KEY:"",INQUIRY_HMAC_SECRET:"",
      NEXT_PUBLIC_SUPABASE_URL:`http://127.0.0.1:${fixture.address().port}`,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:"local-inbox-public-fixture"},
  });
  let output="";app.stdout.on("data",c=>{output+=c;});app.stderr.on("data",c=>{output+=c;});
  t.after(async()=>{if(app.exitCode===null){const exited=once(app,"exit");app.kill();await exited;}});
  for(let n=0;n<150&&!output.includes("Ready in")&&app.exitCode===null;n++)await delay(100);
  assert.match(output,/Ready in/);
  const get=(path,cookieValue,headers={})=>fetch(`http://127.0.0.1:${port}${path}`,{redirect:"manual",headers:{...(cookieValue?{cookie:cookieValue}:{}),...headers}});
  const privateResponse=r=>{
    assert.equal(r.headers.get("cache-control"),"private, no-store, max-age=0");
    assert.equal(r.headers.get("x-robots-tag"),"noindex, nofollow");
  };
  await t.test("missing and expired sessions redirect without private content or query forwarding",async()=>{
    for(const path of [`/dashboard/inquiries/${id}`, "/dashboard", "/onboarding", "/protected"]){
      for(const session of [undefined,expiredCookie]){
        const r=await get(`${path}?creatorId=${a}`,session);privateResponse(r);
        assert.equal(r.status,307,path);assert.equal(new URL(r.headers.get("location"),r.url).pathname,"/auth/login");
        assert.equal(new URL(r.headers.get("location"),r.url).search,"");assert.doesNotMatch(await r.text(),/Private Sender|sender-a@example/);
      }
    }
  });
  await t.test("authenticated private route families send private no-store headers without refresh",async()=>{
    const dashboard=await get("/dashboard",aCookie);privateResponse(dashboard);
    assert.equal(dashboard.status,200);assert.match(await dashboard.text(),/Welcome,\s*(?:<!-- -->)?Creator/);

    const dashboardRsc=await get("/dashboard?_rsc",aCookie,{RSC:"1"});privateResponse(dashboardRsc);
    assert.equal(dashboardRsc.status,200);await dashboardRsc.text();

    const onboarding=await get("/onboarding",cCookie);privateResponse(onboarding);
    assert.equal(onboarding.status,200);assert.match(await onboarding.text(),/Set up your creator profile/);

    const onboardingRedirect=await get("/onboarding",aCookie);privateResponse(onboardingRedirect);
    assert.ok([200,307].includes(onboardingRedirect.status));await onboardingRedirect.text();

    const protectedRoute=await get("/protected",aCookie);privateResponse(protectedRoute);
    assert.ok([200,307].includes(protectedRoute.status));await protectedRoute.text();
  });
  await t.test("successful refresh forwards cookies to rendering and keeps private cache headers",async()=>{
    refreshSucceeds=true;
    try {
      for(const path of ["/dashboard/inquiries", "/dashboard", "/onboarding", "/protected", "/auth/login"]){
        const before=refreshCalls;
        const r=await get(path,expiredCookie);
        if(path==="/auth/login")assert.match(r.headers.get("cache-control")??"",/private.*no-store/);
        else privateResponse(r);
        assert.ok([200,307].includes(r.status),`Unexpected ${r.status} at ${path}`);
        assert.equal(refreshCalls,before+1,`Rendering must reuse the refreshed request cookie for ${path}`);
        assert.match(r.headers.get("set-cookie")??"",/sb-127-auth-token=base64-/);
        assert.equal(r.headers.get("expires"),"0");assert.equal(r.headers.get("pragma"),"no-cache");
        const body=await r.text();
        if(path==="/dashboard/inquiries")assert.match(body,/Private Sender A/);
      }
    } finally {refreshSucceeds=false;}
  });
  await t.test("failed refresh preserves cookie clearing and cache headers on login redirects",async()=>{
    for(const path of ["/dashboard/inquiries", "/dashboard", "/onboarding", "/protected"]){
      const r=await get(`${path}?private=do-not-forward`,expiredCookie);privateResponse(r);
      assert.equal(r.status,307);
      const target=new URL(r.headers.get("location"),r.url);
      assert.equal(target.pathname,"/auth/login");assert.equal(target.search,"");
      assert.match(r.headers.get("set-cookie")??"",/sb-127-auth-token=;/);
      assert.match(r.headers.get("set-cookie")??"",/Max-Age=0/i);
      assert.equal(r.headers.get("expires"),"0");assert.equal(r.headers.get("pragma"),"no-cache");
      await r.text();
    }
  });
  await t.test("list is bounded, uncached, omits email and full message, and provides older cursor",async()=>{
    const r=await get("/dashboard/inquiries",aCookie);privateResponse(r);assert.equal(r.status,200);
    const html=await r.text();assert.match(html,/Private Sender A/);assert.match(html,/Older inquiries/);
    assert.doesNotMatch(html,/sender-a@example|Full private proposal|Never execute me/);
    assert.equal(rpcCalls.at(-1).args.p_limit,21);
    const cursor=html.match(/href="\/dashboard\/inquiries\?cursor=([A-Za-z0-9_-]+)"/)[1];
    const older=await get(`/dashboard/inquiries?cursor=${cursor}`,aCookie);privateResponse(older);
    assert.match(await older.text(),/No inquiries to show/);
  });
  await t.test("owner detail renders escaped full content and UTC timestamp",async()=>{
    const r=await get(`/dashboard/inquiries/${id}`,aCookie);privateResponse(r);
    const html=await r.text();assert.match(html,/sender-a@example.test/);assert.match(html,/Full private proposal/);
    assert.match(html,/&lt;script&gt;Never execute me&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>Never execute me/);assert.match(html,/UTC/);
  });
  await t.test("another session and unknown IDs never receive owner content, including RSC",async()=>{
    for(const [path,headers] of [[`/dashboard/inquiries/${id}`,{}],[`/dashboard/inquiries/${id}?_rsc`,{RSC:"1"}]]){
      const r=await get(path,bCookie,headers);privateResponse(r);
      const body=await r.text();assert.doesNotMatch(body,/Private Sender A|sender-a@example|Full private proposal/);
      // A notFound inside a streamed Suspense boundary may use HTTP 200.
      assert.ok([200,404].includes(r.status), `Unexpected ${r.status} at ${path}; location=${r.headers.get("location")}`);
    }
    const r=await get("/dashboard/inquiries/aaaaaaaa-aaaa-4aaa-8aaa-000000000999",aCookie);
    assert.match(await r.text(),/Inquiry unavailable/);
  });
  await t.test("empty, forged-owner and database-error states are safe",async()=>{
    const empty=await get("/dashboard/inquiries",bCookie);assert.match(await empty.text(),/No inquiries to show/);
    const count=rpcCalls.length;
    for(const badPath of [
      `/dashboard/inquiries?creatorId=${a}`,
      "/dashboard/inquiries?utm_source=chatgpt.com&unknown=1",
      "/dashboard/inquiries?cursor=bad&utm_source=chatgpt.com",
      `/dashboard/inquiries?cursor=${Buffer.from(JSON.stringify({id,created_at:content.created_at})).toString("base64url")}&cursor=${Buffer.from(JSON.stringify({id,created_at:content.created_at})).toString("base64url")}`,
    ]){
      const rejected=await get(badPath,bCookie);privateResponse(rejected);
      assert.match(await rejected.text(),/Invalid inbox page/,badPath);
    }
    assert.equal(rpcCalls.length,count);
    mode="error";
    const failed=await get("/dashboard/inquiries",aCookie);privateResponse(failed);
    assert.doesNotMatch(await failed.text(),/PRIVATE-UPSTREAM-ERROR|sender-a@example/);
    mode="normal";
  });
  await t.test("recognized UTM parameters load the inbox without propagating tracking values",async()=>{
    for(const path of [
      "/dashboard/inquiries?utm_source=chatgpt.com",
      "/dashboard/inquiries?utm_source=chatgpt.com&utm_medium=referral&utm_campaign=launch&utm_content=cta&utm_term=creator",
    ]){
      const r=await get(path,aCookie);privateResponse(r);assert.equal(r.status,200);
      const html=await r.text();
      const visibleHtml=html.replace(/<script\b[\s\S]*?<\/script>/gi,"");
      assert.match(visibleHtml,/Private Sender A/);
      assert.doesNotMatch(visibleHtml,/Invalid inbox page|utm_source|chatgpt\.com/);
      assert.match(visibleHtml,/href="\/dashboard\/inquiries\?cursor=[A-Za-z0-9_-]+"/);
      assert.doesNotMatch(visibleHtml,/href="\/dashboard\/inquiries[^"]*utm_/);
    }
  });
  await t.test("calendar-invalid cursors render invalid state without querying inquiries",async()=>{
    const count=rpcCalls.length;
    for(const created_at of ["2026-02-31T00:00:00.123456Z","2100-02-29T12:00:00+05:30"]){
      const cursor=Buffer.from(JSON.stringify({id,created_at})).toString("base64url");
      const r=await get(`/dashboard/inquiries?cursor=${cursor}`,aCookie);privateResponse(r);
      assert.equal(r.status,200);assert.match(await r.text(),/Invalid inbox page/);
      assert.equal(rpcCalls.length,count);
    }
  });
  await t.test("public responses do not include private inquiry content",async()=>{
    for(const path of ["/", "/c/fixture-creator"]){const r=await get(path);assert.doesNotMatch(await r.text(),/Private Sender A|sender-a@example|Full private proposal/);}
    assert.doesNotMatch(output,/PRIVATE-UPSTREAM-ERROR|sender-a@example|Full private proposal/);
  });
});
