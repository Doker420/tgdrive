// Providers are called only from the server; API keys must never reach browsers.
const asString = value => value == null ? '' : String(value);
const company = (source, category, item) => ({
  id: crypto.randomUUID(), name: asString(item.name), category, address: asString(item.address),
  phone: asString(item.phone), telegram: '', rating: asString(item.rating), reviews: asString(item.reviews),
  description: `${asString(item.name)} — ${category}. Свяжитесь с нами, чтобы узнать подробности.`, status: 'Новая', source, externalId: asString(item.externalId),
});
async function request(url, options) {
  const response = await fetch(url, {...options, signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`Источник вернул HTTP ${response.status}. Проверьте доступ и настройки API.`);
  return response.json();
}
export async function collect({source, category, city, count}, keys = process.env) {
  const query = `${category}, ${city}`;
  const result = [];
  if (source === 'Google Maps') {
    if (!keys.GOOGLE_PLACES_API_KEY) throw new Error('Не задан GOOGLE_PLACES_API_KEY на сервере.');
    let token;
    do {
      const body = {textQuery: query, languageCode: 'ru', pageSize: Math.min(20, count - result.length)};
      if (token) body.pageToken = token;
      const data = await request('https://places.googleapis.com/v1/places:searchText', {method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':keys.GOOGLE_PLACES_API_KEY,'X-Goog-FieldMask':'places.id,places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.rating,places.userRatingCount,nextPageToken'},body:JSON.stringify(body)});
      for (const p of data.places || []) result.push(company(source, category, {externalId:p.id,name:p.displayName?.text,address:p.formattedAddress,phone:p.internationalPhoneNumber,rating:p.rating,reviews:p.userRatingCount}));
      token = data.nextPageToken;
    } while (token && result.length < count);
  } else if (source === 'Яндекс Карты') {
    if (!keys.YANDEX_MAPS_API_KEY) throw new Error('Не задан YANDEX_MAPS_API_KEY на сервере.');
    while (result.length < count) {
      const url = new URL('https://search-maps.yandex.ru/v1/');
      url.search = new URLSearchParams({apikey:keys.YANDEX_MAPS_API_KEY,text:query,type:'biz',lang:'ru_RU',results:String(Math.min(50,count-result.length)),skip:String(result.length)}).toString();
      const data = await request(url);
      const features = data.features || [];
      for (const f of features) { const p=f.properties?.CompanyMetaData || {}; result.push(company(source, category, {externalId:p.id,name:p.name,address:p.address,phone:p.Phones?.[0]?.formatted})); }
      if (!features.length) break;
    }
  } else if (source === '2ГИС') {
    if (!keys.TWOGIS_API_KEY) throw new Error('Не задан TWOGIS_API_KEY на сервере.');
    for (let page=1;result.length<count && page<=6;page++) {
      const url = new URL('https://catalog.api.2gis.com/3.0/items');
      url.search = new URLSearchParams({key:keys.TWOGIS_API_KEY,q:query,page:String(page),page_size:'50',fields:'items.full_address_name,items.contact_groups,items.reviews'}).toString();
      const data = await request(url);
      if (data.meta?.code && data.meta.code !== 200) throw new Error(`2ГИС: ошибка API ${data.meta.code}. Проверьте доступ к полям.`);
      const items=data.result?.items || [];
      for (const p of items) { const contacts=(p.contact_groups || []).flatMap(g=>g.contacts || []); result.push(company(source,category,{externalId:p.id,name:p.name,address:p.full_address_name || p.address_name,phone:contacts.find(c=>c.type==='phone')?.text,rating:p.reviews?.general_rating,reviews:p.reviews?.general_review_count})); }
      if (items.length < 50) break;
    }
  } else throw new Error('Неизвестный источник.');
  return result.filter(item=>item.name && item.externalId).slice(0,count);
}
