import dotenv from "dotenv";
import nodemailer from "nodemailer";
import express from "express";

dotenv.config();

const app = express();
app.use(express.json());

// Gmail SMTP transporter
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
    }
});

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function buildEnquiryMail({ name, email, mobile, message }) {
    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safeMobile = escapeHtml(mobile);
    const safeMessage = escapeHtml(message).replaceAll("\n", "<br>");

    return {
        subject: `Enquiry from ${name}`,
        text: `Email: ${email}\n\nMobile: ${mobile}\n\nName: ${name}\n\nBodyy: ${message}`,
        html: `
            <div style="font-family: Arial, sans-serif; color: #243229; line-height: 1.7;">
                <p><strong>Email:</strong> ${safeEmail}</p>
                <p><strong>Mobile:</strong> ${safeMobile}</p>
                <p><strong>Name:</strong> ${safeName}</p>
                <p><strong>Bodyy:</strong><br>${safeMessage}</p>
            </div>
        `,
    };
}

// Send email in background
function sendEmailBackground(to, subject, text, html) {
    setImmediate(async () => {
        try {
            await transporter.sendMail({
                from: process.env.GMAIL_USER,
                to,
                subject,
                text,
                html
            });

            console.log("Email sent successfully");
        } catch (error) {
            console.error("Email failed:", error);
        }
    });
}

app.post("/send-email", (req, res) => {
    const { to, subject, text, html, name, email, mobile, message } = req.body;

    const enquiryPayload = name && email && mobile && message
        ? buildEnquiryMail({ name, email, mobile, message })
        : null;

    res.json({
        success: true,
        message: "Email queued"
    });

    if (enquiryPayload) {
        sendEmailBackground(to || process.env.GMAIL_USER, enquiryPayload.subject, enquiryPayload.text, enquiryPayload.html);
        return;
    }

    sendEmailBackground(to, subject, text, html);
});

app.listen(process.env.PORT || 4000, () => {
    console.log(`Server running on port ${process.env.PORT || 4000}`);
});
