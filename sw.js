/* FLEX TUPUP — service worker (notifications). Mete fichye sa a bò kote index.html (menm dosye, menm domèn). */
self.addEventListener('install',function(e){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});

/* Push reyèl (sit la fèmen) — voye pa backend la ak web-push */
self.addEventListener('push',function(e){
  var d={};
  try{d=e.data?e.data.json():{}}catch(_){d={title:'FLEX TUPUP',body:e.data?e.data.text():''}}
  e.waitUntil(self.registration.showNotification(d.title||'FLEX TUPUP',{
    body:d.body||'',
    tag:d.tag||('flex-'+Date.now()),
    data:{url:d.url||'./'},
    vibrate:[120,60,120]
  }));
});

self.addEventListener('notificationclick',function(e){
  e.notification.close();
  var url=(e.notification.data&&e.notification.data.url)||'./';
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(list){
    for(var i=0;i<list.length;i++){if('focus' in list[i])return list[i].focus()}
    return self.clients.openWindow(url);
  }));
});
