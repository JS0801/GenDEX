/**
 * @NApiVersion 2.x
 * @NScriptType fiParserPlugin
 * @NModuleScope SameAccount
 *
 * BAI2 Parser – Financial Institution Parser Plug-in
 * Handles records: 01, 02, 03, 16, 88, 49, 98, 99
 *
 * Record 88 continuation data (reference, fund type, fund name)
 * is merged into the transaction memo BEFORE calling createNewTransaction.
 */
define(["N/log", "N/url"], function (log, url) {

  // ══════════════════════════════════════════════════
  //  STANDARD TRANSACTION CODES
  // ══════════════════════════════════════════════════

  var STANDARD_CODES = [
    // Credit codes (100-399)
    { transactionCode: "100", transactionType: "CREDIT",   creditDebit: "CREDIT", description: "Total Credits" },
    { transactionCode: "108", transactionType: "CREDIT",   creditDebit: "CREDIT", description: "Credit Reversal" },
    { transactionCode: "115", transactionType: "DEPOSIT",  creditDebit: "CREDIT", description: "Lockbox Deposit" },
    { transactionCode: "116", transactionType: "DEPOSIT",  creditDebit: "CREDIT", description: "Item in Lockbox Deposit" },
    { transactionCode: "135", transactionType: "CREDIT",   creditDebit: "CREDIT", description: "Letters Of Credit" },
    { transactionCode: "142", transactionType: "ACH",      creditDebit: "CREDIT", description: "ACH Credits Received" },
    { transactionCode: "145", transactionType: "TRANSFER", creditDebit: "CREDIT", description: "Incoming Money Transfer" },
    { transactionCode: "155", transactionType: "ACH",      creditDebit: "CREDIT", description: "Preauthorized ACH Credit" },
    { transactionCode: "165", transactionType: "ACH",      creditDebit: "CREDIT", description: "Preauthorized ACH Credit" },
    { transactionCode: "171", transactionType: "ACH",      creditDebit: "CREDIT", description: "Individual ACH Credit" },
    { transactionCode: "175", transactionType: "DEPOSIT",  creditDebit: "CREDIT", description: "Check Deposit" },
    { transactionCode: "195", transactionType: "DEPOSIT",  creditDebit: "CREDIT", description: "Check Deposited" },
    { transactionCode: "198", transactionType: "CREDIT",   creditDebit: "CREDIT", description: "Miscellaneous Credit" },
    { transactionCode: "301", transactionType: "DEPOSIT",  creditDebit: "CREDIT", description: "Commercial Deposit" },
    { transactionCode: "355", transactionType: "TRANSFER", creditDebit: "CREDIT", description: "Sweep Credit" },
    { transactionCode: "501", transactionType: "ACH",      creditDebit: "CREDIT", description: "Individual ACH Debit Return" },
    { transactionCode: "698", transactionType: "INTEREST", creditDebit: "CREDIT", description: "Interest Credit" },
    // Debit codes (400-699+)
    { transactionCode: "201", transactionType: "ACH",      creditDebit: "DEBIT",  description: "Individual ACH Debit" },
    { transactionCode: "225", transactionType: "CHECK",    creditDebit: "DEBIT",  description: "Check Paid" },
    { transactionCode: "255", transactionType: "ACH",      creditDebit: "DEBIT",  description: "Preauthorized ACH Debit" },
    { transactionCode: "275", transactionType: "ACH",      creditDebit: "DEBIT",  description: "ACH Debit Received" },
    { transactionCode: "354", transactionType: "TRANSFER", creditDebit: "DEBIT",  description: "Sweep Debit" },
    { transactionCode: "399", transactionType: "FEE",      creditDebit: "DEBIT",  description: "Miscellaneous Fee" },
    { transactionCode: "400", transactionType: "DEBIT",    creditDebit: "DEBIT",  description: "Total Debits" },
    { transactionCode: "408", transactionType: "OTHER",    creditDebit: "DEBIT",  description: "Float Adjustment" },
    { transactionCode: "451", transactionType: "ACH",      creditDebit: "DEBIT",  description: "Individual ACH Return" },
    { transactionCode: "475", transactionType: "CHECK",    creditDebit: "DEBIT",  description: "Check Paid - Cashed" },
    { transactionCode: "495", transactionType: "CHECK",    creditDebit: "DEBIT",  description: "Check Paid" },
    { transactionCode: "555", transactionType: "TRANSFER", creditDebit: "DEBIT",  description: "Wire Transfer Out" },
    { transactionCode: "720", transactionType: "INTEREST", creditDebit: "DEBIT",  description: "Interest Debit" }
  ];

  // Lookup map for quick access
  var CODE_MAP = {};
  STANDARD_CODES.forEach(function (c) { CODE_MAP[c.transactionCode] = c; });

  // ══════════════════════════════════════════════════
  //  INTERFACE: getConfigurationPageUrl
  // ══════════════════════════════════════════════════

  function getConfigurationPageUrl(context) {
    var suiteletUrl = url.resolveScript({
      scriptId:     "customscript_bai2_parser_config_s",
      deploymentId: "customdeploy_bai2_parser_config_s"
    });
    context.configurationPageUrl = suiteletUrl;
  }

  // ══════════════════════════════════════════════════
  //  INTERFACE: getStandardTransactionCodes
  // ══════════════════════════════════════════════════

  function getStandardTransactionCodes(context) {
    STANDARD_CODES.forEach(function (entry) {
      context.createNewStandardTransactionCode({
        transactionCode: entry.transactionCode,
        transactionType: entry.transactionType,
        creditDebit:     entry.creditDebit,
        description:     entry.description
      });
    });
  }

  // ══════════════════════════════════════════════════
  //  INTERFACE: parseData
  // ══════════════════════════════════════════════════
  //
  //  Strategy: Two-phase per account
  //    Phase 1 – Collect record 16 + 88 pairs into a pending array
  //    Phase 2 – On record 49 (account trailer), flush all pending
  //              transactions with full memo into createNewTransaction
  //
  //  This ensures Record 88 continuation data is merged into the
  //  memo BEFORE the transaction is created (since createNewTransaction
  //  returns void and cannot be updated afterward).

  function parseData(context) {
    var rawText = _getRawText(context);
    var records = _tokenize(rawText);

    log.debug({ title: "BAI2 Parser", details: "Logical records: " + records.length });

    var currentAccount     = null;
    var groupAsOfDate      = "";
    var pendingTransactions = [];   // array of { fields, continuations }
    var currentTxn         = null;  // the transaction currently collecting 88s

    records.forEach(function (record) {
      var fields     = record.split(",");
      var recordType = fields[0].trim();

      // ── 01 – File Header ──
      if (recordType === "01") {
        log.debug({
          title:   "File Header",
          details: "Sender: " + (fields[1] || "") +
                   ", Receiver: " + (fields[2] || "") +
                   ", Date: " + _formatBAI2Date(fields[3])
        });
      }

      // ── 02 – Group Header ──
      else if (recordType === "02") {
        groupAsOfDate = _formatBAI2Date(fields[4]);
        log.debug({
          title:   "Group Header",
          details: "AsOfDate: " + groupAsOfDate +
                   ", Currency: " + (fields[6] || "USD")
        });
      }

      // ── 03 – Account Identifier & Summary ──
      else if (recordType === "03") {
        // Reset for new account
        pendingTransactions = [];
        currentTxn          = null;

        var parsed03 = _parseRecord03(fields);
        log.debug({ title: "Account", details: JSON.stringify(parsed03) });

        currentAccount = context.createAccountData({
          accountId:      parsed03.accountNumber,
          openingBalance: parsed03.openingBalance,
          closingBalance: parsed03.closingBalance,
          dataAsOfDate:   groupAsOfDate
        });
      }

      // ── 16 – Transaction Detail ──
      else if (recordType === "16") {
        // Start a new pending transaction
        currentTxn = {
          fields:        fields,
          continuations: []
        };
        pendingTransactions.push(currentTxn);
      }

      // ── 88 – Continuation Record ──
      else if (recordType === "88") {
        if (currentTxn) {
          // Append 88 data to the current transaction
          currentTxn.continuations.push(fields.slice(1).join(",").trim());
        }
      }

      // ── 49 – Account Trailer ──
      // Flush all pending transactions with full memo
      else if (recordType === "49") {
        if (currentAccount) {
          _flushAllTransactions(currentAccount, pendingTransactions, groupAsOfDate);
        }

        pendingTransactions = [];
        currentTxn          = null;
        currentAccount      = null;

        log.debug({
          title:   "Account Trailer",
          details: "Control Total: " + _parseAmount(fields[1]) +
                   ", Records: " + (fields[2] || "")
        });
      }

      // ── 98 – Group Trailer ──
      else if (recordType === "98") {
        log.debug({ title: "Group Trailer", details: record });
      }

      // ── 99 – File Trailer ──
      else if (recordType === "99") {
        log.debug({ title: "File Trailer", details: record });
      }

      else {
        log.audit({ title: "Unknown Record", details: record });
      }
    });
  }

  // ══════════════════════════════════════════════════
  //  HELPER FUNCTIONS
  // ══════════════════════════════════════════════════

  /**
   * Flush all pending transactions (16 + 88 pairs) into createNewTransaction.
   * Memo is built from Record 88 continuation data.
   */
  function _flushAllTransactions(account, pendingTransactions, asOfDate) {
    pendingTransactions.forEach(function (pending) {
      var fields    = pending.fields;
      var typeCode  = (fields[1] || "").trim();
      var amount    = _parseAmount(fields[2]);
      var fundsType = (fields[3] || "").trim();
      var codeInfo  = CODE_MAP[typeCode];

      // ── Parse Record 88 continuation data ──
      var ref88      = "";
      var fundType88 = "";
      var fundName88 = "";

      if (pending.continuations.length > 0) {
        var fullCont  = pending.continuations.join(",");
        var contParts = fullCont.split(",");

        ref88      = (contParts[0] || "").trim();  // e.g. "4812A0367"
        fundType88 = (contParts[1] || "").trim();  // e.g. "Money Market Fund"
        fundName88 = (contParts[2] || "").trim();  // e.g. "JPMorgan Prime Money Market Fund Capital Shares"
      }

      // ── Build memo ──
      // If Record 88 has fund type, use that as memo; otherwise fall back to code description or record 16 text
      var memo = "";
      if (fundType88) {
        memo = fundType88;
      } else if (fundsType !== "S" && fundsType !== "V" && fundsType !== "D") {
        var text = (fields[6] || "").trim();
        memo = text || (codeInfo ? codeInfo.description : "BAI2 Code " + typeCode);
      } else {
        memo = codeInfo ? codeInfo.description : "BAI2 Code " + typeCode;
      }

      // ── Build uniqueId for duplicate detection ──
      var uniqueId = asOfDate + "_" + typeCode + "_" + Math.abs(amount);
      if (ref88) {
        uniqueId = asOfDate + "_" + typeCode + "_" + ref88;
      }

      // ── Create the transaction ──
      var txnData = {
        date:                asOfDate,
        amount:              Math.abs(amount),
        transactionTypeCode: typeCode,
        memo:                memo,
        uniqueId:            uniqueId
      };

      // id → maps to Tran ID in NetSuite
      if (ref88) {
        txnData.id = ref88;
      }

      // payee → maps to Name (debitor/creditor) in NetSuite
      if (fundName88) {
        txnData.payee = fundName88;
      }

      // customer reference
      if (ref88) {
        txnData.customerReferenceId = ref88;
      }

      log.debug({ title: "Creating Transaction", details: JSON.stringify(txnData) });

      account.createNewTransaction(txnData);
    });
  }

  /**
   * Read all lines from the FI parser input context.
   */
  function _getRawText(context) {
    var lines = [];
    context.inputData.lines.iterator().each(function (line) {
      if (line.value) { lines.push(line.value); }
      return true;
    });
    return lines.join("\n");
  }

  /**
   * Tokenize BAI2 file into logical records (split on "/").
   */
  function _tokenize(raw) {
    var joined  = raw.replace(/\r?\n/g, "");
    var parts   = joined.split("/");
    var records = [];
    parts.forEach(function (p) {
      var trimmed = p.trim();
      if (trimmed) { records.push(trimmed); }
    });
    return records;
  }

  /**
   * Parse Record 03 – Account Identifier & Summary.
   * Example: 03,5032794,USD,010,7369671904,,,015,7069671904/
   */
  function _parseRecord03(fields) {
    var accountNumber  = (fields[1] || "").trim();
    var currency       = (fields[2] || "USD").trim();
    var openingBalance = 0;
    var closingBalance = 0;

    var i = 3;
    while (i < fields.length) {
      var typeCode = (fields[i] || "").trim();
      if (!typeCode) { i++; continue; }

      if (typeCode === "010" || typeCode === "040") {
        openingBalance = _parseAmount(fields[i + 1]);
        i += 2;
      } else if (typeCode === "015" || typeCode === "045") {
        closingBalance = _parseAmount(fields[i + 1]);
        i += 2;
      } else {
        i++;
      }
    }

    return {
      accountNumber:  accountNumber,
      currency:       currency,
      openingBalance: openingBalance,
      closingBalance: closingBalance
    };
  }

  /**
   * Convert BAI2 amount (cents) to dollars.
   * 300000000 → $3,000,000.00
   */
  function _parseAmount(val) {
    if (!val) { return 0; }
    var cleaned = val.trim();
    if (!cleaned) { return 0; }

    var negative = false;
    if (cleaned.charAt(0) === "-") {
      negative = true;
      cleaned  = cleaned.substring(1);
    }

    var n = parseInt(cleaned, 10);
    if (isNaN(n)) { return 0; }

    var result = n / 100;
    return negative ? -result : result;
  }

  /**
   * Format BAI2 date YYMMDD → YYYY-MM-DD (ISO 8601).
   */
  function _formatBAI2Date(dateStr) {
    if (!dateStr || dateStr.length < 6) { return dateStr || ""; }
    return "20" + dateStr.substring(0, 2) + "-" +
           dateStr.substring(2, 4) + "-" +
           dateStr.substring(4, 6);
  }

  // ══════════════════════════════════════════════════
  //  EXPORTS
  // ══════════════════════════════════════════════════
  return {
    getConfigurationPageUrl:     getConfigurationPageUrl,
    getStandardTransactionCodes: getStandardTransactionCodes,
    parseData:                   parseData
  };
});