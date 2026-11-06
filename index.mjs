import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand
} from "@aws-sdk/lib-dynamodb";
//hi 
const API_BASE = "https://sandbox.ae.asp.veutel.com";
const TABLE = process.env.TABLE_NAME || "marmin_submissions";
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const reply = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

async function getVeutelToken() {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(process.env.VEUTEL_CLIENT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(process.env.VEUTEL_CLIENT_ID)
  );
  const signature = btoa(String.fromCharCode(...new Uint8Array(signed)));

  const response = await fetch(
    `${API_BASE}/auth/token?client_id=` +
      encodeURIComponent(process.env.VEUTEL_CLIENT_ID),
    {
      headers: { "X-HMAC-Signature": signature },
      redirect: "manual",
      signal: AbortSignal.timeout(15000)
    }
  );
  if (!response.ok) {
    throw new Error(`Veutel token request HTTP ${response.status}`);
  }
  const body = await response.json();
  if (typeof body.token !== "string" || body.token.split(".").length !== 3) {
    throw new Error("Veutel did not return a JWT");
  }
  return body.token;
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method;
  if (method !== "POST") {
    return { statusCode: 200, body: "Marmin sender is running." };
  }

  const auth = event.headers?.authorization;
  if (
    !process.env.TEST_SECRET ||
    auth !== `Bearer ${process.env.TEST_SECRET}`
  ) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  const {
    VEUTEL_CLIENT_ID,
    VEUTEL_CLIENT_SECRET,
    MARMIN_BUSINESS_PROFILE_ID,
    BUYER_JSON
  } = process.env;

  if (
    !VEUTEL_CLIENT_ID ||
    !VEUTEL_CLIENT_SECRET ||
    !MARMIN_BUSINESS_PROFILE_ID ||
    !BUYER_JSON
  ) {
    return reply(503, { error: "Missing settings" });
  }

  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString()
      : event.body;
    const input = JSON.parse(raw);
    const invoice = input.Invoice || input;
    const buyer = JSON.parse(BUYER_JSON);

    if (!invoice?.Id || !invoice?.DocNumber) {
      return reply(400, { error: "QuickBooks invoice ID or number missing" });
    }

    delete buyer.profile_id;

    const payload = {
      document_number: invoice.DocNumber,
      invoice_type_code: "380",
      profile_execution_id: "00000000",
      issue_date: invoice.TxnDate,
      due_date: invoice.DueDate,
      document_currency_code: "AED",
      accounting_customer_party: buyer,
      payment_means: [{ payment_means_code: "10", payment_id: [] }],
      prepaid_amount: 0,
      payable_rounding_amount: 0,
      document_source: "API",
      document_lines: (invoice.Line || [])
        .filter((line) => line.DetailType === "SalesItemLineDetail")
        .map((line) => {
          const item = line.SalesItemLineDetail;
          return {
            name: item.ItemRef?.name || line.Description,
            description: line.Description || item.ItemRef?.name,
            quantity: Number(item.Qty),
            unit_code: "EA",
            classified_tax_category: {
              id: "S",
              percent: 5,
              tax_scheme: "VAT"
            },
            price: {
              base_amount: Number(item.UnitPrice),
              base_quantity: 1
            }
          };
        })
    };

    const jwt = await getVeutelToken();
    const submissionKey = `${MARMIN_BUSINESS_PROFILE_ID}:${invoice.Id}`;

    // Duplicate protection (replaces D1 INSERT OR IGNORE)
    try {
      await db.send(
        new PutCommand({
          TableName: TABLE,
          Item: { submission_key: submissionKey, status: "sending" },
          ConditionExpression: "attribute_not_exists(submission_key)"
        })
      );
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") {
        const prev = await db.send(
          new GetCommand({
            TableName: TABLE,
            Key: { submission_key: submissionKey }
          })
        );
        const accepted = prev.Item?.status === "accepted";
        return reply(accepted ? 200 : 502, {
          quickbooks_invoice_id: invoice.Id,
          already_attempted: true,
          previous_status: prev.Item?.status || "unknown",
          marmin_http_ok: accepted
        });
      }
      throw err;
    }

    const url =
      `${API_BASE}/api/sales-invoices/` +
      encodeURIComponent(MARMIN_BUSINESS_PROFILE_ID);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        "X-API-Version": "20260507"
      },
      body: JSON.stringify(payload),
      redirect: "manual",
      signal: AbortSignal.timeout(20000)
    });

    const text = await response.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      result = text;
    }

    const documentId = result?.id || result?.uuid || result?.document_uuid || null;

    if (response.status === 401) {
      await db.send(
        new DeleteCommand({
          TableName: TABLE,
          Key: { submission_key: submissionKey }
        })
      );
    } else {
      await db.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { submission_key: submissionKey },
          UpdateExpression: "SET #s = :s",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":s": response.ok ? "accepted" : "needs_review"
          }
        })
      );
    }

    console.log(
      JSON.stringify({
        quickbooksInvoiceId: invoice.Id,
        veutelHttpStatus: response.status,
        documentId
      })
    );

    return reply(response.ok ? 200 : 502, {
      marmin_http_ok: response.ok,
      marmin_http_status: response.status,
      quickbooks_invoice_id: invoice.Id,
      marmin_document_id: documentId,
      marmin_response: result
    });
  } catch (error) {
    return reply(502, {
      error: error.message,
      note: "Check Veutel and DynamoDB before retrying an uncertain invoice."
    });
  }
};