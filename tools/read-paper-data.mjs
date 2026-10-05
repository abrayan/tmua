// Read the inert JSON payload without importing a compiler or CLI entrypoint.
const fail=message=>{throw Error(`Paper data: ${message}`);};
function dataScript(html,scriptId='tmua-paper-data'){
  const found=[];
  for(const match of html.matchAll(/<!--[\s\S]*?-->|<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)(<\/script\s*>|$)/gi)){
    if(match[1]===undefined)continue;
    const attrs={};
    for(const attr of match[1].matchAll(/([^\s=\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))attrs[attr[1].toLowerCase()]=attr[2]??attr[3]??attr[4]??'';
    if(attrs.id!==scriptId)continue;
    if(attrs.type?.toLowerCase()!=='application/json'||!match[3])fail('paper data must be one complete application/json script.');
    const start=match.index+7+match[1].length+1;
    found.push({start,end:start+match[2].length,text:match[2]});
  }
  if(found.length!==1)fail(`paper must contain exactly one ${scriptId} script.`);
  return found[0];
}
export function readPaperData(html){return JSON.parse(dataScript(html).text);}
