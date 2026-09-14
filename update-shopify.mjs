import fs from "node:fs/promises";
import { gzipSync } from "node:zlib";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error("Falta el secreto " + name + " en GitHub");
  return value;
}

const shop = required("SHOPIFY_STORE_DOMAIN").replace(/^https?:\/\//, "").replace(/\/$/, "");
const clientId = required("SHOPIFY_CLIENT_ID");
const clientSecret = required("SHOPIFY_CLIENT_SECRET");
const apiVersion = "2026-07";

async function getToken() {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret
  });
  const response = await fetch("https://" + shop + "/admin/oauth/access_token", {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body
  });
  if (!response.ok) throw new Error("Shopify no aceptó las credenciales (" + response.status + ")");
  return (await response.json()).access_token;
}

async function graphql(token, query, variables = {}) {
  const response = await fetch("https://" + shop + "/admin/api/" + apiVersion + "/graphql.json", {
    method: "POST",
    headers: {"Content-Type": "application/json", "X-Shopify-Access-Token": token},
    body: JSON.stringify({query, variables})
  });
  const json = await response.json();
  if (!response.ok || json.errors) throw new Error("Error de Shopify: " + JSON.stringify(json.errors || json));
  return json.data;
}

const PRODUCT_QUERY = "query Products($after:String){products(first:100,after:$after,query:\"status:active\"){nodes{id title collections(first:50){nodes{title}} variants(first:100){nodes{id title sku inventoryQuantity}}} pageInfo{hasNextPage endCursor}}}";
const ORDER_QUERY = "query Orders($after:String,$query:String!){orders(first:100,after:$after,query:$query,sortKey:CREATED_AT){nodes{cancelledAt lineItems(first:250){nodes{quantity variant{id}}} refunds{refundLineItems(first:250){nodes{quantity lineItem{variant{id}}}}}} pageInfo{hasNextPage endCursor}}}";

async function allProducts(token) {
  const products = [];
  let after = null;
  do {
    const data = await graphql(token, PRODUCT_QUERY, {after});
    products.push(...data.products.nodes);
    after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (after);
  return products;
}

async function salesLastEightWeeks(token) {
  const sold = new Map();
  const since = new Date(Date.now() - 56 * 86400000).toISOString();
  let after = null;
  do {
    const data = await graphql(token, ORDER_QUERY, {after, query: "created_at:>=" + since + " status:any"});
    for (const order of data.orders.nodes) {
      if (order.cancelledAt) continue;
      for (const item of order.lineItems.nodes) {
        const id = item.variant?.id;
        if (id) sold.set(id, (sold.get(id) || 0) + item.quantity);
      }
      for (const refund of order.refunds) {
        for (const item of refund.refundLineItems.nodes) {
          const id = item.lineItem?.variant?.id;
          if (id) sold.set(id, (sold.get(id) || 0) - item.quantity);
        }
      }
    }
    after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (after);
  return sold;
}

const rules = [
  ["Hoodies","1000 GSM","1000 GSM HOODIES"],["Hoodies","750 GSM","750 GSM HOODIES"],["Hoodies","600 GSM","600 GSM HOODIES"],["Hoodies","450 GSM","450 GSM HOODIES"],
  ["T-shirts","300 GSM Slim Fit","300 GSM SLIM FIT"],["T-shirts","300 GSM","300 GSM T-SHIRT"],["T-shirts","180 GSM","180 GSM T-SHIRTS"],
  ["Shirts","Linen","LINEN SHIRT"],["Shirts","Poplin","POPLIN SHIRT"],
  ["Shorts","Denim Shorts","Denim Shorts"],["Shorts","Cargo Shorts","SHORT RIPSTOP"],["Shorts","600 GSM","600 GSM SHORT PANTS"],["Shorts","Mesh Shorts","MESH SHORTS"],["Shorts","Linen Shorts","LINEN SHORTS"],
  ["Zippers","600 GSM","600 GSM ZIPPER"],["Zippers","450 GSM","450 GSM ZIPPER"],
  ["Knitwear","Gauge 3","GAUGE 3"],["Knitwear","Gauge 7","GAUGE 7"],
  ["Straight Pants","750 GSM","750 STRAIGHT PANTS"],["Straight Pants","600 GSM","600 STRAIGHT PANTS"],["Straight Pants","450 GSM","450 GSM STRAIGHT PANTS"],
  ["Sweatpants","600 GSM","600 GSM SWEATPANTS"],["Sweatpants","450 GSM","450 GSM SWEATPANTS"],
  ["Trousers","Jeans","JEANS"],["Trousers","Cargos","CARGOS"],["Trousers","Corduroy","CORDUROY PANTS"],["Trousers","Carpenters","CARPENTERS"],["Trousers","Double Knee","DOUBLE KNEE"],["Trousers","Linen Trousers","LINEN TROUSERS"],
  ["Crewnecks","600 GSM","600 GSM CREWNECK"],["Crewnecks","450 GSM","450 GSM CREWNECK"],
  ["Longsleeves","300 GSM","300 GSM LONGSLEEVES"],["Longsleeves","Thermal","THERMAL"],
  ["Jackets","Work Jackets","WORK JACKETS"],["Jackets","Denim Jackets","DENIM JACKETS"],["Jackets","Twill Jackets","TWILL JACKETS"],["Jackets","Bomber Jackets","BOMBER JACKET"],["Jackets","Corduroy Jackets","CORDUROY JACKET"],
  ["Socks","All","SOCKS"]
];

function makeDashboardData(products, sold) {
  const result = [];
  for (const product of products) {
    if (/mystery box/i.test(product.title)) continue;
    const collections = new Set(product.collections.nodes.map(x => x.title));
    const rule = rules.find(x => collections.has(x[2]));
    if (!rule) continue;
    for (const variant of product.variants.nodes) {
      const units = Math.max(0, sold.get(variant.id) || 0);
      result.push({
        id: variant.id.split("/").pop(), name: product.title, sku: variant.sku || "",
        size: variant.title, stock: variant.inventoryQuantity || 0,
        weekly: Number((units / 8).toFixed(2)), category: rule[0], subcategory: rule[1]
      });
    }
  }
  return result;
}

const token = await getToken();
const [products, sold] = await Promise.all([allProducts(token), salesLastEightWeeks(token)]);
const dashboardData = makeDashboardData(products, sold);
const encoded = gzipSync(JSON.stringify(dashboardData)).toString("base64");
const file = new URL("../index.html", import.meta.url);
const html = await fs.readFile(file, "utf8");
const marker = /const CATALOG_GZIP='[^']*';/;
if (!marker.test(html)) throw new Error("No se encontró CATALOG_GZIP en index.html");
const updated = html.replace(marker, "const CATALOG_GZIP='" + encoded + "';");
await fs.writeFile(file, updated);
console.log("Actualización terminada: " + products.length + " productos y " + dashboardData.length + " variantes.");
