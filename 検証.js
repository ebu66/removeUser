/**
 * ユーザ削除処理の事前チェック（読み取り専用・削除は一切行わない）
 *
 * スクリプトプロパティに以下を設定してから verifyTargetUsers を実行する。
 *   SPREADSHEET_ID     : 対象ユーザを記載したスプレッドシートのID
 *   SHEET_NAME         : シート名
 *   TENANT_ID    : Entra ID テナントID
 *   CLIENT_ID    : アプリ登録のクライアントID
 *   CLIENT_SECRET: アプリ登録のクライアントシークレット
 */

const VERIFY_HEADER_ROWS = 1; // 見出し行の数
const DEFAULT_TRANSFER_TO = 'appsadmin@odk.co.jp'; // B列が空の場合の移行先

/** 各行のデータをチェックし、削除・移行が実行可能かを出力する */
function verifyTargetUsers() {
  const users = readTargetUsers();
  console.log('対象件数: ' + users.length);
  logValidationResults(validateTargets(users, getEntraToken()));
}

/**
 * 全行をチェックし、行ごとの結果を返す
 * @return {{user: Object, transferTo: string, gwsUser: Object, destUser: Object, entraUser: Object, errors: string[]}[]}
 */
function validateTargets(users, token) {
  // 移行先が削除対象に含まれているかを全行で判定するため、先に削除対象を集める
  const deleteTargets = {};
  users.forEach(function (u) {
    if (u.userId) deleteTargets[u.userId] = true;
  });

  const seen = {};

  return users.map(function (u) {
    const errors = [];
    const transferTo = u.transferTo || DEFAULT_TRANSFER_TO;
    let gwsUser = null;
    let destUser = null;
    let entraUser = null;

    if (!u.userId) errors.push('A列(ユーザID)が空');
    if (u.userId && u.userId === transferTo) errors.push('削除対象と移行先が同一');
    if (u.userId && seen[u.userId]) errors.push('行' + seen[u.userId] + 'と重複');
    if (u.userId && !seen[u.userId]) seen[u.userId] = u.row;

    if (u.userId) {
      gwsUser = findGwsUser(u.userId);
      if (!gwsUser) errors.push('GWSに削除対象が存在しない');
      else if (gwsUser.isAdmin) errors.push('削除対象がGWS特権管理者');

      entraUser = findEntraUser(token, u.userId);
      if (!entraUser) errors.push('Entraに削除対象が存在しない');
    }

    if (u.userId !== transferTo) {
      if (deleteTargets[transferTo]) {
        errors.push('移行先も削除対象に含まれている');
      } else {
        destUser = findGwsUser(transferTo);
        if (!destUser) errors.push('GWSに移行先が存在しない');
        else if (destUser.suspended) errors.push('移行先が停止中');
      }
    }

    return {
      user: u,
      transferTo: transferTo,
      gwsUser: gwsUser,
      destUser: destUser,
      entraUser: entraUser,
      errors: errors,
    };
  });
}

/** チェック結果をログに出力し、NG件数を返す */
function logValidationResults(results) {
  let ngCount = 0;
  results.forEach(function (r) {
    const label = '行' + r.user.row + ' ' + r.user.userId + ' → ' + r.transferTo;
    if (r.errors.length) {
      ngCount++;
      console.warn('❌ ' + label + ': ' + r.errors.join(' / '));
    } else {
      console.log('✅ ' + label);
    }
  });
  console.log('チェック結果: OK ' + (results.length - ngCount) + '件 / NG ' + ngCount + '件');
  return ngCount;
}

/** スプレッドシートの対象ユーザを読み込む（A列: 削除対象, B列: 移行先） */
function readTargetUsers() {
  const props = PropertiesService.getScriptProperties();
  const sheet = SpreadsheetApp.openById(props.getProperty('SPREADSHEET_ID'))
    .getSheetByName(props.getProperty('SHEET_NAME'));
  if (!sheet) throw new Error('シートが見つかりません: ' + props.getProperty('SHEET_NAME'));

  const lastRow = sheet.getLastRow();
  if (lastRow <= VERIFY_HEADER_ROWS) return [];

  return sheet.getRange(VERIFY_HEADER_ROWS + 1, 1, lastRow - VERIFY_HEADER_ROWS, 2)
    .getValues()
    .map(function (row, i) {
      return {
        row: VERIFY_HEADER_ROWS + 1 + i,
        // 大文字小文字違いの重複を検出できるよう小文字に揃える
        userId: String(row[0]).trim().toLowerCase(),
        transferTo: String(row[1]).trim().toLowerCase(),
      };
    })
    .filter(function (u) { return u.userId || u.transferTo; });
}

/** Entra ID (Microsoft Graph) のアクセストークンを取得する */
function getEntraToken() {
  const props = PropertiesService.getScriptProperties();
  const res = UrlFetchApp.fetch(
    'https://login.microsoftonline.com/' + props.getProperty('TENANT_ID') + '/oauth2/v2.0/token',
    {
      method: 'post',
      payload: {
        client_id: props.getProperty('CLIENT_ID'),
        client_secret: props.getProperty('CLIENT_SECRET'),
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      },
      muteHttpExceptions: true,
    }
  );
  if (res.getResponseCode() !== 200) {
    throw new Error('Entraトークン取得失敗: ' + res.getContentText());
  }
  return JSON.parse(res.getContentText()).access_token;
}

/** GWS のユーザを取得（存在しなければ null） */
function findGwsUser(userId) {
  try {
    return AdminDirectory.Users.get(userId);
  } catch (e) {
    if (String(e.message).indexOf('Resource Not Found') !== -1) return null;
    throw e;
  }
}

/** Entra ID のユーザを取得（存在しなければ null） */
function findEntraUser(token, userId) {
  const res = UrlFetchApp.fetch(
    'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(userId) +
      '?$select=id,userPrincipalName,displayName,accountEnabled',
    { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }
  );
  if (res.getResponseCode() === 404) return null;
  if (res.getResponseCode() !== 200) {
    throw new Error('Entraユーザ取得失敗 (' + userId + '): ' + res.getContentText());
  }
  return JSON.parse(res.getContentText());
}
