(() => {
  let current = null;
  globalThis.__GSM_FIND__ = (text, options = {}) => {
    if (!text) { CSS.highlights?.delete('gsm-find'); current=null;getSelection()?.removeAllRanges();return {matches:0,activeMatchOrdinal:0}; }
    const needle=options.matchCase?text:text.toLocaleLowerCase();
    const ranges=[];
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{acceptNode(node){
      return node.parentElement?.closest('script,style,textarea,input,[hidden],[aria-hidden="true"],.find-in-page-toolbar')||!node.parentElement?.getClientRects().length?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT;
    }});
    while(walker.nextNode()) {
      const node=walker.currentNode,value=options.matchCase?node.textContent:node.textContent.toLocaleLowerCase();
      for(let index=value.indexOf(needle);index!==-1;index=value.indexOf(needle,index+needle.length)) {
        const range=document.createRange();range.setStart(node,index);range.setEnd(node,index+text.length);ranges.push(range);
      }
    }
    let index=0;
    if(current?.text===text&&current.matchCase===!!options.matchCase&&!options.findNext)index=(current.index+(options.forward===false?-1:1)+ranges.length)%Math.max(1,ranges.length);
    else if(options.forward===false)index=Math.max(0,ranges.length-1);
    current={text,matchCase:!!options.matchCase,index};
    if(CSS.highlights&&typeof Highlight==='function') {
      if(!document.getElementById('gsm-find-style')){const style=document.createElement('style');style.id='gsm-find-style';style.textContent='::highlight(gsm-find){background:#e9bf55;color:#131720}';document.head.append(style);}
      CSS.highlights.set('gsm-find',new Highlight(...ranges));
    }
    const selection=getSelection();selection?.removeAllRanges();
    if(ranges[index]){selection?.addRange(ranges[index]);ranges[index].startContainer.parentElement?.scrollIntoView({block:'center',inline:'nearest'});}
    return {matches:ranges.length,activeMatchOrdinal:ranges.length?index+1:0};
  };
})();
