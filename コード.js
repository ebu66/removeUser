/**
 * ユーザ削除処理
 *
 * 1. 全行をチェックし、1件でもNGがあれば何もせず中断する
 * 2. 全員分のデータ移行（ドライブ / カレンダー / Looker Studio）を依頼する
 * 3. 移行が完了したユーザから GWS → Entra ID の順に削除する
 *    （Entra ID は GWS の削除リクエストが成功した場合のみ削除する）
 *
 * スクリプトプロパティは 検証.js を参照。
 */

const DRY_RUN = true; // true の間はチェックのみで、移行・削除は行わない

const TRANSFER_WAIT_LIMIT_MS = 5 * 60 * 1000; // GAS の実行時間上限(6分)に収まるよう移行完了を待つ上限
const TRANSFER_POLL_INTERVAL_MS = 10 * 1000;

// 移行するアプリと、管理コンソールで手作業時に指定している内容
const TRANSFER_APPS = [
  // ドライブとドキュメント: 誰とも共有していないファイルも含める
  { name: /^Drive and Docs$/i, params: { PRIVACY_LEVEL: ['PRIVATE', 'SHARED'] } },
  // カレンダー: リソースの解放はしない（RELEASE_RESOURCES を指定しない）
  { name: /^Calendar$/i, params: {} },
  // データポータル(Looker Studio): 誰とも共有していないアセットは含めない
  { name: /Looker Studio|Data Studio/i, params: { PRIVACY_LEVEL: ['SHARED'] } },
];

function removeUser() {
  const startedAt = Date.now();
  const users = readTargetUsers();
  console.log('対象件数: ' + users.length);
  if (!users.length) return;

  const token = getEntraToken();
  const results = validateTargets(users, token);
  const ngCount = logValidationResults(results);
  if (ngCount) {
    throw new Error('チェックでNGが ' + ngCount + ' 件あるため処理を中断しました');
  }
  if (DRY_RUN) {
    console.log('DRY_RUN のため移行・削除は行いません');
    return;
  }

  // Google 側で並行して処理されるよう、先に全員分の移行を依頼する
  const apps = getTransferApplications();
  const jobs = results.map(function (r) {
    const transfer = requestDataTransfer(apps, r.gwsUser.id, r.destUser.id);
    console.log('移行依頼: ' + r.user.userId + ' → ' + r.transferTo + ' (' + transfer.id + ')');
    return { result: r, transferId: transfer.id, status: transfer.overallTransferStatusCode };
  });

  waitForTransfers(jobs, startedAt + TRANSFER_WAIT_LIMIT_MS);

  const summary = { deleted: 0, skipped: 0, failed: 0 };
  jobs.forEach(function (job) {
    const r = job.result;
    if (job.status !== 'completed') {
      summary.skipped++;
      console.warn('⏸ ' + r.user.userId + ': 移行が未完了(' + job.status + ')のため削除しません');
      return;
    }
    try {
      AdminDirectory.Users.remove(r.gwsUser.id);
    } catch (e) {
      summary.failed++;
      console.error('❌ ' + r.user.userId + ': GWS削除失敗のためEntraは削除しません: ' + e.message);
      return;
    }
    try {
      deleteEntraUser(token, r.entraUser.id);
      summary.deleted++;
      console.log('🗑 ' + r.user.userId + ': GWS・Entra とも削除しました');
    } catch (e) {
      summary.failed++;
      console.error('❌ ' + r.user.userId + ': GWSは削除済み、Entra削除失敗: ' + e.message);
    }
  });

  console.log('処理結果: 削除 ' + summary.deleted + '件 / 移行未完了 ' + summary.skipped +
    '件 / 失敗 ' + summary.failed + '件');
}

/** TRANSFER_APPS に対応する Data Transfer API のアプリ定義を取得する */
function getTransferApplications() {
  const available = [];
  let pageToken;
  do {
    const page = AdminDataTransfer.Applications.list({ customerId: 'my_customer', pageToken: pageToken });
    (page.applications || []).forEach(function (a) { available.push(a); });
    pageToken = page.nextPageToken;
  } while (pageToken);

  return TRANSFER_APPS.map(function (def) {
    const app = available.find(function (a) { return def.name.test(a.name); });
    if (!app) {
      throw new Error('移行対象アプリが見つかりません: ' + def.name +
        ' (利用可能: ' + available.map(function (a) { return a.name; }).join(', ') + ')');
    }
    return { id: app.id, name: app.name, params: def.params };
  });
}

/** データ移行を依頼する */
function requestDataTransfer(apps, oldOwnerId, newOwnerId) {
  return AdminDataTransfer.Transfers.insert({
    oldOwnerUserId: oldOwnerId,
    newOwnerUserId: newOwnerId,
    applicationDataTransfers: apps.map(function (app) {
      return {
        applicationId: app.id,
        applicationTransferParams: Object.keys(app.params).map(function (key) {
          return { key: key, value: app.params[key] };
        }),
      };
    }),
  });
}

/** 全ての移行が完了・失敗するか、期限に達するまで待つ（job.status を更新する） */
function waitForTransfers(jobs, deadline) {
  const isPending = function (job) { return job.status !== 'completed' && job.status !== 'failed'; };

  while (jobs.some(isPending) && Date.now() + TRANSFER_POLL_INTERVAL_MS < deadline) {
    Utilities.sleep(TRANSFER_POLL_INTERVAL_MS);
    jobs.filter(isPending).forEach(function (job) {
      job.status = AdminDataTransfer.Transfers.get(job.transferId).overallTransferStatusCode;
    });
  }
}

/** Entra ID のユーザを削除する（削除済みユーザに移動し、30日間は復元可能） */
function deleteEntraUser(token, entraUserId) {
  const res = UrlFetchApp.fetch(
    'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(entraUserId),
    { method: 'delete', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 204) {
    throw new Error('HTTP ' + res.getResponseCode() + ' ' + res.getContentText());
  }
}
