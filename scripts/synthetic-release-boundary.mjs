/** Local lifecycle fixture only: no cryptographic provenance claim or production override.
 * Populate the complete retained target so the real owner readiness path executes.
 */
export function syntheticReleaseBoundary({
  installedRoot,
  source,
  legacy = false,
}) {
  return `
import {createHash as fixtureHash} from 'node:crypto';
import {parseManifest as fixtureManifest} from ${JSON.stringify(installedRoot + "/dist/release/manifest.js")};
Updates.prototype.readyRelease=async function(request){
 const r=await request('https://api.github.com/repos/stevefortier/katafit-coach/git/ref/heads/main');
 if(!r.ok)throw Error('UNAVAILABLE');
 const sha=(await r.json()).object.sha;
 if(!/^[a-f0-9]{40}$/.test(sha))throw Error('UNAVAILABLE');
 const hash=fixtureHash('sha256').update('katafit-native-contract-2\\0');
 for(const name of ['package.json','package-lock.json','sandbox/Dockerfile','sandbox/launch.mjs','sandbox/relay.mjs','sandbox/katafit.mjs']){
  const bytes=cp.execFileSync('git',['show',sha+':'+name],{cwd:${JSON.stringify(source)},maxBuffer:4*1024*1024});
  hash.update(name+'\\0'+bytes.length+'\\0').update(bytes);
 }
 this.releaseTarget=fixtureManifest({version:1,repository:'stevefortier/katafit-coach',revision:sha,fingerprint:hash.digest('hex'),platform:'linux/amd64',image:'sha256:'+'f'.repeat(64),protocol:2,launcher:'manual-only-ready-releases-1',node:'26.10.0',artifacts:[{name:'coach-'+sha+'.tgz',size:1,sha256:'0'.repeat(64)},{name:'native-'+sha+'.tar.gz',size:1,sha256:'0'.repeat(64)}]});
 ${legacy ? "this.sourceChannel='legacy-or-unknown';this.observeReadiness=async()=>undefined;this.readinessSupported=true;" : ""}
 return sha;
};`;
}
