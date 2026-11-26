import { createServer } from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import worker from "../dist/server/index.js";

const database = join(mkdtempSync(join(tmpdir(), "two-calendar-preview-")), "preview.sqlite");
const port = Number(process.env.PREVIEW_PORT || 4173);
const origin = `http://127.0.0.1:${port}`;
const python = process.env.PYTHON || "python3";
function sql(mode, query, params=[]) {
  const result = spawnSync(python,["tests/sqlite_bridge.py"],{input:JSON.stringify({database,mode,sql:query,params}),encoding:"utf8"});
  if(result.status!==0)throw Error(result.stderr);
  return JSON.parse(result.stdout);
}
for(const file of ["drizzle/0000_init.sql","drizzle/0001_public_auth.sql","drizzle/0002_privacy_email.sql","drizzle/0003_language.sql"])sql("migration",readFileSync(file,"utf8"));
const DB={prepare(query){return{bind(...params){return{first:async()=>sql("first",query,params),all:async()=>sql("all",query,params),run:async()=>sql("run",query,params)}}}},batch:async statements=>{const results=[];for(const statement of statements)results.push(await statement.run());return results}};
const outbox=[];
const server=createServer(async(req,res)=>{
  if(req.url==="/__test/outbox"&&req.method==="GET"){res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(outbox));return}
  const body=[];for await(const chunk of req)body.push(chunk);
  const url=origin+req.url;
  const headers=new Headers(req.headers);
  headers.set("cf-connecting-ip","127.0.0.1");
  try{
    const response=await worker.fetch(new Request(url,{method:req.method,headers,body:body.length?Buffer.concat(body):undefined}),{DB,PUBLIC_SITE_ORIGIN:origin,__sendTestEmail:async mail=>outbox.push(mail)});
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(e){res.writeHead(500);res.end(String(e))}
});
server.listen(port,"127.0.0.1",()=>console.log("Local preview: "+origin));
