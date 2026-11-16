"use strict";

/*
    Email to a chatbot owner's support address ("Email your question" in the chat widget).

    SMTP settings come from .env (never from the browser or the database):
      SMTP_HOST     mail server, e.g. smtp.example.com          (required)
      SMTP_FROM     sender address, e.g. chatbot@example.com     (required)
      SMTP_PORT     default 587 (STARTTLS); 465 with SMTP_SECURE=true
      SMTP_SECURE   "true" for a TLS connection from the start (port 465)
      SMTP_USER / SMTP_PASS   login, if the server needs one
    Without SMTP_HOST and SMTP_FROM no email is sent: the contact form is still offered to visitors and
    their questions are saved for the dashboard (email_status "disabled").

    EMAIL_TRANSPORT=test (automated tests only): messages are kept in memory and NEVER sent.
*/

const nodemailer = require("nodemailer");

let transport = null;
const testOutbox = [];

function emailMode() {
    if (String(process.env.EMAIL_TRANSPORT || "").toLowerCase() === "test") return "test";
    return process.env.SMTP_HOST && process.env.SMTP_FROM ? "smtp" : null;
}

function isEmailConfigured() {
    return Boolean(emailMode());
}

// Names (never values) of the required SMTP settings that are not set; empty when email works.
function missingSmtpSettings() {
    if (emailMode()) return [];
    return ["SMTP_HOST", "SMTP_FROM"].filter(name => !process.env[name]);
}

function getTransport() {
    if (transport) return transport;
    const mode = emailMode();
    if (mode === "test") {
        transport = {
            sendMail: async message => {
                testOutbox.push(message);
                return { messageId: `<test-${testOutbox.length}@localhost>` };
            }
        };
    } else if (mode === "smtp") {
        const port = Number(process.env.SMTP_PORT) || 587;
        transport = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port,
            secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
            auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined,
            // A slow or unreachable mail server must not hold the visitor's request for long.
            connectionTimeout: 15000,
            greetingTimeout: 15000,
            socketTimeout: 30000
        });
    }
    return transport;
}

// The sender address: SMTP_FROM, only its address part when it is written as "Name <address>" (the
// display name comes from the chatbot that sends). "chatbot@localhost" is only reached with
// EMAIL_TRANSPORT=test and no SMTP_FROM (real SMTP requires SMTP_FROM).
function senderAddress() {
    const from = String(process.env.SMTP_FROM || "").trim();
    const bracketed = from.match(/<([^<>\s]+)>\s*$/);
    return (bracketed ? bracketed[1] : from) || "chatbot@localhost";
}

// message: { to, fromName, replyTo: { name, address }, subject, text }. fromName must already be
// header-safe (server.js headerText). Throws if email is not configured or the mail server refuses it.
async function sendSupportEmail({ fromName, ...message }) {
    const active = getTransport();
    if (!active) throw new Error("Email is not configured.");
    const address = senderAddress();
    return active.sendMail({ ...message, from: fromName ? { name: fromName, address } : address });
}

module.exports = {
    isEmailConfigured,
    missingSmtpSettings,
    sendSupportEmail,
    // Tests only (EMAIL_TRANSPORT=test): messages "sent", and a way to simulate a failing server.
    _testOutbox: testOutbox,
    _setTransportForTests: replacement => { transport = replacement; }
};
