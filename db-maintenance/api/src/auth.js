import { config } from './config.js';

// 認証ミドルウェア層。
// 現時点では認証なし(IT部門内限定利用)だが、将来 Entra ID (Container Apps Easy Auth) を
// ここに差し込める構造にしている。Easy Auth 導入時は
// X-MS-CLIENT-PRINCIPAL / X-MS-CLIENT-PRINCIPAL-NAME ヘッダーから操作者を取得する。
export function authMiddleware(req, _res, next) {
  // Easy Auth が有効な場合はヘッダーが付与される(現状は未設定なので undefined)
  const principalName = req.get('x-ms-client-principal-name');
  req.operator = principalName || config.operatorName || '未認証';
  next();
}
