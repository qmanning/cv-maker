var P={letter:{label:"8.5 \xD7 11 in",name:"US Letter",w:612,h:792},a4:{label:"210 \xD7 297 mm",name:"A4",w:595,h:842}},T=24,_=30,M=96/72,k=.8,u=e=>{let t=e.replace(/[\t\n\r]/g,"").replace(/^[\u0000-\u0020]+/,""),r=/^([a-z][a-z0-9+.-]*):/i.exec(t);return r?r[1].toLowerCase():""},d=new Set(["href","action","formaction","ping","background","xlink:href"]),h=new Set(["","http","https","mailto","tel"]),f=new Set(["javascript","vbscript"]),b=/^(:root|html|body)(?![\w-])/i,v=new Set(["media","supports","container","layer","scope","document"]);function x(e,t){let r=e.trim(),o=!1;for(;;){let n=b.exec(r);if(!n)break;o=!0,r=r.slice(n[0].length);let i=/^\s+(?=(:root|html|body)(?![\w-]))/i.exec(r);if(!i)break;r=r.slice(i[0].length)}return o?t+r:t+" "+r}var y=(e,t)=>e.split(",").map(r=>r.trim()).filter(Boolean).map(r=>x(r,t)).join(", ");function A(e,t){let r=0,o=t;for(;o<e.length;){let n=e[o];if(n==="/"&&e[o+1]==="*"){let i=e.indexOf("*/",o+2);o=i<0?e.length:i+2;continue}if(n==='"'||n==="'"){let i=o+1;for(;i<e.length&&e[i]!==n;)i+=e[i]==="\\"?2:1;o=i+1;continue}if(n==="{")r++;else if(n==="}"&&(r--,r===0))return{body:e.slice(t+1,o),end:o+1};o++}return{body:e.slice(t+1),end:e.length}}function S(e,t=".cvm-host"){if(!e.trim())return"";let r=[],o="",n=0;for(;n<e.length;){let i=e[n];if(i==="/"&&e[n+1]==="*"){let s=e.indexOf("*/",n+2),a=s<0?e.slice(n):e.slice(n,s+2);o+=a,n+=a.length;continue}if(i==='"'||i==="'"){let s=n+1;for(;s<e.length&&e[s]!==i;)s+=e[s]==="\\"?2:1;o+=e.slice(n,s+1),n=s+1;continue}if(i===";"){let s=o.trim();s&&!/^@import\b/i.test(s)&&r.push(s+";"),o="",n++;continue}if(i==="{"){let{body:s,end:a}=A(e,n);n=a;let c=[],l=o.replace(/\/\*[\s\S]*?\*\//g,m=>(c.push(m)," ")).trim();if(o="",c.length&&r.push(c.join(`
`)),l.startsWith("@")){let m=(/^@([\w-]+)/.exec(l)||["",""])[1].toLowerCase();r.push(v.has(m)?`${l} {
${S(s,t)}
}`:`${l} {${s}}`)}else l&&r.push(`${y(l,t)} {${s}}`);continue}o+=i,n++}return r.join(`
`)}var E=/(^|[}\n])([^{}]*?)li\s*\+\s*li\s*\{\s*margin-top\s*:\s*([^;}]+?)\s*;?\s*\}/g,w=e=>e.replace(E,(t,r,o,n)=>`${r}${o}li:not(:last-child) { margin-bottom: ${n}; }`);function C(e){let t=new DOMParser().parseFromString(e,"text/html");t.querySelectorAll("script, iframe, object, embed, link[rel='import']").forEach(n=>n.remove()),t.querySelectorAll("*").forEach(n=>Array.from(n.attributes).forEach(i=>{if(/^on/i.test(i.name))return n.removeAttribute(i.name);let s=u(i.value);if(f.has(s))return n.removeAttribute(i.name);d.has(i.name.toLowerCase())&&!h.has(s)&&n.removeAttribute(i.name)}));let r=w(Array.from(t.querySelectorAll("style")).map(n=>n.textContent||"").join(`
`)),o=t.body.querySelector(".cv-page");return o||(o=t.createElement("div"),o.className="cv-page",o.append(...Array.from(t.body.childNodes))),{css:r,html:o.outerHTML,name:t.title.trim(),regions:o.querySelectorAll("[data-cv-edit]").length}}var R=e=>/data-cv-kind="letter"|data-cv-mirror="header"/.test(e)?"letter":"resume",L="/* icedcoffee:letter",O="/* itera:letter",g=e=>{let t=e.indexOf(L);return t>=0?t:e.indexOf(O)},$=e=>{let t=g(e);return t<0?e:e.slice(t)},q=(e,t)=>g(t)<0?t:e.trimEnd()+`
`+$(t);function j(e,t){let r=c=>new DOMParser().parseFromString(c,"text/html"),o=r(e),n=o.querySelector('[data-cv-mirror="header"]'),i=r(t),s=i.querySelector(".cv-page [data-cv-header]")||i.querySelector(".cv-page > header");if(!n||!s)return e;let a=o.importNode(s,!0);return[a,...Array.from(a.querySelectorAll("*"))].forEach(c=>["data-cv-edit","contenteditable","translate","tabindex","spellcheck","role","aria-multiline","aria-label","data-cv-repeat"].forEach(l=>c.removeAttribute(l))),a.querySelectorAll(".ProseMirror, .tiptap").forEach(c=>c.classList.remove("ProseMirror","tiptap","ProseMirror-focused")),a.classList.remove("ProseMirror","tiptap","ProseMirror-focused"),a.setAttribute("data-cv-block",""),a.setAttribute("data-cv-mirror","header"),n.replaceWith(a),o.body.innerHTML}var N=(e,t=1)=>`
.cv-page { width: ${(e/t).toFixed(3)}pt; zoom: ${t}; box-sizing: border-box; position: relative; margin: 0 auto;
  padding: var(--cv-pad-top, 16pt) calc((${(e/t).toFixed(3)}pt - var(--cv-content-w, 562pt)) / 2) var(--cv-pad-bottom, 16pt); }
.cvm-pagebreak { break-before: page; height: var(--cv-pad-top, 16pt); }
.cvm-pageno { position: absolute; left: 0; right: 0; text-align: center; font: 7pt/1 Helvetica, Arial, sans-serif; color: #555; }`,F=(e,t,r,o="")=>`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${e.replace(/[<&]/g,"")}</title>
<style>
${t}
</style>${o?`
<style>${o}</style>`:""}
</head>
<body>
${r}
</body>
</html>
`,G=e=>e.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"resume",p=[.25,.33,.5,.67,.75,.9,1,1.1,1.25,1.5,1.75,2,2.5,3],I=(e,t)=>t>0?p.find(r=>r>e+.005)??p[p.length-1]:[...p].reverse().find(r=>r<e-.005)??p[0];export{P as a,T as b,_ as c,M as d,k as e,S as f,w as g,C as h,R as i,q as j,j as k,N as l,F as m,G as n,I as o};
