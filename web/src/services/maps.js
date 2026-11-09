import {escapeHTML,directionsURL} from '../domain/model.js';
import {icon} from '../ui/icons.js';
let googleLoad;
function loadGoogle(key) {
  if(globalThis.google?.maps?.importLibrary)return Promise.resolve(globalThis.google.maps);
  if(googleLoad)return googleLoad;
  googleLoad=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Map request timed out')),10000);
    window.clubbyMapsReady=()=>{clearTimeout(timer);resolve(google.maps);};
    window.gm_authFailure=()=>{clearTimeout(timer);reject(new Error('Google Maps key needs configuration'));};
    const script=document.createElement('script');
    script.src=`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&loading=async&callback=clubbyMapsReady&v=weekly&libraries=marker`;
    script.async=true;script.onerror=()=>{clearTimeout(timer);reject(new Error('Map unavailable'));};document.head.append(script);
  });return googleLoad;
}
/** Nearby addresses share a picker so stacked markers never hide a venue. */
export function groupMapVenues(venues){
  const groups=[];
  for(const v of venues.filter(v=>Number.isFinite(v.latitude)&&Number.isFinite(v.longitude))){
    const nearby=groups.find(group=>Math.hypot((group[0].latitude-v.latitude)*111000,(group[0].longitude-v.longitude)*78000)<30);
    if(nearby)nearby.push(v);else groups.push([v]);
  }
  return groups;
}
function pinContent(group){return group.length>1?`<span class="map-cluster-number">${group.length}</span>`:icon(group[0].category==='Bars & rooftops'?'glass':group[0].category==='Live music'?'music':'moon');}
function clusterPicker(group,onSelect){
  const panel=document.createElement('div');panel.className='map-place-picker';
  const heading=document.createElement('strong');heading.textContent='Places at this location';panel.append(heading);
  for(const v of group){const button=document.createElement('button');button.type='button';button.textContent=v.name;button.addEventListener('click',()=>onSelect(v.id));panel.append(button);}
  return panel;
}
export async function mountMap(host,venues,onSelect,config={}) {
  const status=host.parentElement.querySelector('[data-map-provider]');
  let controller;
  if(config.googleMapsApiKey){
    try{
      const g=await loadGoogle(config.googleMapsApiKey);
      if(!host.isConnected)return null;
      const {AdvancedMarkerElement}=await g.importLibrary('marker');
      const map=new g.Map(host,{center:{lat:45.47,lng:9.194},zoom:12,mapId:config.googleMapsMapId||'DEMO_MAP_ID',disableDefaultUI:true,zoomControl:true,gestureHandling:'cooperative',colorScheme:'DARK'});
      let markers=[],currentItems=[];const popup=new g.InfoWindow();
      controller={setVenues(items){currentItems=items;popup.close();markers.forEach(m=>m.map=null);markers=groupMapVenues(items).map(group=>{const v=group[0],node=document.createElement('button');node.className='map-pin';node.innerHTML=pinContent(group);node.setAttribute('aria-label',group.map(v=>v.name).join(', '));const m=new AdvancedMarkerElement({map,position:{lat:v.latitude,lng:v.longitude},content:node,title:group.map(v=>v.name).join(', ')});node.addEventListener('click',()=>{if(group.length===1)onSelect(v.id);else{popup.setContent(clusterPicker(group,id=>{onSelect(id);popup.close();}));popup.open({anchor:m,map});}});return m;});},focus(v){map.panTo({lat:v.latitude,lng:v.longitude});map.setZoom(15);},fit(){if(currentItems.length){const bounds=new g.LatLngBounds();currentItems.filter(v=>Number.isFinite(v.latitude)&&Number.isFinite(v.longitude)).forEach(v=>bounds.extend({lat:v.latitude,lng:v.longitude}));map.fitBounds(bounds,55);}else{map.setCenter({lat:45.47,lng:9.194});map.setZoom(12);}},destroy(){popup.close();markers.forEach(m=>m.map=null);}};
      if(status)status.textContent='Google Maps';
    }catch{if(status)status.textContent='Street map';}
  }
  if(!controller){
    if(!host.isConnected)return null;
    const L=window.L;
    if(!L){host.innerHTML='<div class="map-unavailable"><p>The map is unavailable.</p><a href="https://www.google.com/maps/search/?api=1&query=Milan+nightlife" target="_blank" rel="noopener noreferrer">Explore Milan in Google Maps</a></div>';return null;}
    const map=L.map(host,{zoomControl:false,scrollWheelZoom:false,minZoom:10,maxZoom:19}).setView([45.47,9.194],12);
    L.control.zoom({position:'bottomright'}).addTo(map);
    const tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',className:'street-tiles'}).addTo(map);
    let tileErrors=0;tiles.on('tileerror',()=>{if(++tileErrors===3&&status)status.textContent='Map connection interrupted';});
    let markers=[];
    controller={setVenues(items){map.closePopup();markers.forEach(m=>m.remove());markers=groupMapVenues(items).map(group=>{
      const v=group[0];const marker=L.marker([v.latitude,v.longitude],{title:group.map(v=>v.name).join(', '),keyboard:true,icon:L.divIcon({className:'map-pin-holder',html:`<span class="map-pin">${pinContent(group)}</span>`,iconSize:[38,38],iconAnchor:[19,38]})}).addTo(map);
      marker.bindTooltip(escapeHTML(group.length===1?v.name:`${group.length} places · click to choose`),{direction:'top',offset:[0,-30]});
      if(group.length===1)marker.on('click',()=>onSelect(v.id));
      else marker.bindPopup(clusterPicker(group,id=>{onSelect(id);map.closePopup();}),{closeButton:true,maxWidth:260});
      return marker;
    });},focus(v){if(Number.isFinite(v.latitude)&&Number.isFinite(v.longitude))map.flyTo([v.latitude,v.longitude],15,{duration:.6});},fit(){if(markers.length)map.fitBounds(L.featureGroup(markers).getBounds(),{padding:[40,40],maxZoom:15});else map.setView([45.47,9.194],12);},destroy(){map.remove();}};
    if(status)status.textContent='Street map · OSM';
    requestAnimationFrame(()=>{if(host.isConnected){map.invalidateSize();controller.fit();}});
  }
  controller.setVenues(venues);return controller;
}
