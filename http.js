// Réponses HTTP communes aux modules (JSON et redirection), sans dépendance.
export function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

export function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('location', location);
  res.end();
}
