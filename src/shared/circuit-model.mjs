import { componentTerminalPoints } from './layout-agent.mjs';
import { engineeringNumber } from './engineering.mjs';

// Declarative component graph. The drawing and BOM are generated together;
// simulation later re-extracts the DRAWN pin nets instead of using these nets.
export class CircuitBuilder {
  constructor(id, title) { this.id=id; this.title=title; this.devices=[]; this.ports={}; this.notes=[]; }
  add(type, ref, value, pins, spice, options={}) {
    if(this.devices.some(d=>d.ref===ref))throw new Error(`Duplicate device ${ref}`);
    this.devices.push({type,ref,value,pins,spice,...options}); return this;
  }
  r(ref,a,b,value,type='resistor'){return this.add(type,ref,engineeringNumber(value,'Ω'),{A:a,B:b},{kind:'R',value});}
  c(ref,a,b,value,type='capacitor'){return this.add(type,ref,engineeringNumber(value,'F'),{TOP:a,BOTTOM:b},{kind:'C',value});}
  l(ref,a,b,value){return this.add('inductor',ref,engineeringNumber(value,'H'),{A:a,B:b},{kind:'L',value});}
  d(ref,a,k,model='DIODE',type='diode'){return this.add(type,ref,model,{A:a,K:k},{kind:'D',model});}
  q(ref,c,b,e,model='NPN'){return this.add('bjt',ref,model,{C:c,B:b,E:e},{kind:'Q',model});}
  m(ref,d,g,s,model='NMOS'){return this.add(model==='PMOS'?'pmosfet':'mosfet',ref,model,{D:d,G:g,S:s},{kind:'M',model});}
  op(ref,p,n,out,vp='VP',vn='VN'){return this.add('opamp',ref,'OPAMP model',{P:p,N:n,OUT:out,VP:vp,VN:vn},{kind:'X',model:'OPAMP'}, {customPins:true});}
  cmp(ref,p,n,out,vp='VP',vn='0'){return this.add('comparator',ref,'CMP model',{P:p,N:n,OUT:out,VP:vp,VN:vn},{kind:'X',model:'CMP'},{customPins:true});}
  ic(ref,model,pins,type='ic'){return this.add(type,ref,model,pins,{kind:'X',model},{customPins:true});}
  v(ref,a,b,value,port=null){
    this.add('source',ref,`${value} V`,{A:a,B:b},{kind:'V',value});
    if(port)this.ports[port]={source:ref,net:a,returnNet:b}; return this;
  }
  i(ref,a,b,value,port=null){
    this.add('source',ref,`${value} A`,{A:a,B:b},{kind:'I',value});
    if(port)this.ports[port]={source:ref,net:a,returnNet:b};return this;
  }
  output(name,net,returnNet='0'){
    this.add('terminal',`J_${name}`,name,{P:net},null);this.ports[name]={net,returnNet};return this;
  }
  rails(positive=9,negative=-9){this.v('VCC','VP','0',positive,'SUPPLY');this.v('VEE','VN','0',negative,'NEG_SUPPLY');return this;}
  load(out,value=10000,ref='RLOAD',gnd='0'){return this.r(ref,out,gnd,value);}
  finish(extra={}) {
    const components=[],wires=[],bom=[];
    for(const [index,device] of this.devices.entries()){
      const x=180+(index%3)*360,y=130+Math.floor(index/3)*250;
      const component={type:device.type,ref:device.ref,value:device.value,x,y,rotate:0,spice:device.spice};
      if(device.customPins){
        const ids=Object.keys(device.pins),half=Math.ceil(ids.length/2);
        component.bodyHeight=Math.max(100,half*28+25);
        component.pinDefinitions=ids.map((id,i)=>({id,offset:[i<half?-70:70,((i%half)-(half-1)/2)*28],normal:[i<half?-1:1,0]}));
      }
      const terminals=componentTerminalPoints(component);
      if(terminals.length!==Object.keys(device.pins).length||terminals.some(p=>!(p.id in device.pins)))throw new Error(`${device.ref}: symbol/model pin mismatch`);
      components.push(component);
      for(const pin of terminals){
        const net=device.pins[pin.id];
        if(!/^[A-Za-z0-9_]+$/.test(net))throw new Error(`Invalid net ${net}`);
        const nx=pin.normal[0]||(!pin.normal[1]?1:0),ny=pin.normal[1];
        const end=[pin.x+nx*45,pin.y+ny*35];
        components.push({type:'net-label',ref:`N_${device.ref}_${pin.id}`,value:net,net,x:end[0],y:end[1],labelAnchor:nx<0?'end':'start',labelX:nx<0?-5:5,labelY:ny>0?14:-5});
        wires.push({points:[[pin.x,pin.y],end]});
      }
      if(device.spice)bom.push({ref:device.ref,value:device.value,role:`${device.spice.model||device.spice.kind} · 参数化模型元件`,footprint:'需按实际器件选定'});
    }
    return {
      title:this.title,topology:this.title,function:`${this.title}的可审计元件与网络。`,confidence:0.65,
      components:bom,connections:this.devices.filter(d=>d.spice).map(d=>`${d.ref}: ${Object.entries(d.pins).map(([p,n])=>`${p}→${n}`).join('；')}`),
      schematic:{width:1080,height:Math.ceil(this.devices.length/3)*250+60,components,wires},
      circuitModel:{version:1,id:this.id,ports:this.ports,devices:this.devices.map(d=>({ref:d.ref,pins:d.pins,spice:d.spice})),
        fidelity:'通用元件/有限参数宏模型，非目标厂商器件认证模型',hardwareMeasured:false},
      assumptions:['网络标签同名即电气连接；模型默认值须按真实器件重新确认。',...this.notes],
      warnings:['尚未执行本次方案的仿真；不能仅因模型可导出而标为仿真通过。'],
      pcbTips:['先核对器件型号、引脚与封装，再布板。','高电流回路与信号回路分别规划。'],
      nextSteps:['执行对应工作点、交流或瞬态仿真。','复核器件额定值和实际负载。'],
      verificationPlan:['核对图纸网络与导出的仿真网表一致。','在额定、边界与容差条件下检查波形。'],
      ...extra,
    };
  }
}
