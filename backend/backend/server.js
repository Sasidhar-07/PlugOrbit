const express = require("express");
const cors = require("cors");
require("dotenv").config();

const pool = require("./db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 5001;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware
app.use(cors());
app.use(express.json());

// Debug logger
app.use((req, res, next) => {
  console.log(`${req.method} request made to: ${req.url}`);
  next();
});

// Razorpay init
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Home
app.get("/", (req, res) => {
  res.json({ message: "PlugOrbit Online" });
});

/* ================= BOOKINGS ================= */

/* ================= VERIFY PAYMENT AND CREATE BOOKING ================= */

app.post("/verify-payment-and-book", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      userId,
      stationId,
      stationName,
      date,
      time,
      vehicle,
      duration,
      razorpayPaymentId,
      razorpayOrderId,
      razorpaySignature,
    } = req.body;

    if (
      !userId ||
      !stationId ||
      !stationName ||
      !date ||
      !time ||
      !vehicle ||
      !duration ||
      !razorpayPaymentId ||
      !razorpayOrderId ||
      !razorpaySignature
    ) {
      return res.status(400).json({
        success: false,
        message: "Missing payment or booking details",
      });
    }

    const numericDuration = Number(duration);
    const expectedAmount = SLOT_PRICES[numericDuration];

    if (!expectedAmount) {
      return res.status(400).json({
        success: false,
        message: "Invalid charging duration",
      });
    }

    /*
      1. Verify Razorpay signature.

      Razorpay signature formula:
      HMAC_SHA256(orderId + "|" + paymentId, keySecret)
    */
    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");

    const receivedBuffer = Buffer.from(
      String(razorpaySignature),
      "utf8"
    );

    const generatedBuffer = Buffer.from(
      generatedSignature,
      "utf8"
    );

    const signatureIsValid =
      receivedBuffer.length === generatedBuffer.length &&
      crypto.timingSafeEqual(
        receivedBuffer,
        generatedBuffer
      );

    if (!signatureIsValid) {
      return res.status(400).json({
        success: false,
        message: "Payment verification failed",
      });
    }

    /*
      2. Fetch the Razorpay order from Razorpay itself.

      This prevents the phone from changing the amount.
    */
    const razorpayOrder = await razorpay.orders.fetch(
      razorpayOrderId
    );

    if (!razorpayOrder) {
      return res.status(400).json({
        success: false,
        message: "Payment order was not found",
      });
    }

    const expectedAmountInPaise = expectedAmount * 100;

    if (
      Number(razorpayOrder.amount) !== expectedAmountInPaise ||
      razorpayOrder.currency !== "INR"
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment amount does not match booking price",
      });
    }

    /*
      3. Fetch and verify the payment status.
    */
    const razorpayPayment = await razorpay.payments.fetch(
      razorpayPaymentId
    );

    if (!razorpayPayment) {
      return res.status(400).json({
        success: false,
        message: "Payment was not found",
      });
    }

    if (
      razorpayPayment.order_id !== razorpayOrderId ||
      Number(razorpayPayment.amount) !== expectedAmountInPaise ||
      razorpayPayment.currency !== "INR"
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment details do not match the order",
      });
    }

    if (razorpayPayment.status !== "captured") {
      return res.status(400).json({
        success: false,
        message: `Payment is ${razorpayPayment.status}, not captured`,
      });
    }

    await client.query("BEGIN");

    /*
      4. Prevent the same Razorpay payment from creating
         multiple bookings.
    */
    const duplicatePayment = await client.query(
      `SELECT id
       FROM bookings
       WHERE payment_id = $1
          OR order_id = $2
       LIMIT 1`,
      [razorpayPaymentId, razorpayOrderId]
    );

    if (duplicatePayment.rows.length > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message: "This payment has already been used",
      });
    }

    /*
      5. Lock and verify the slot inside the transaction.
    */
    const existingSlot = await client.query(
      `SELECT id
       FROM bookings
       WHERE station_id::text = $1::text
         AND date = $2
         AND time = $3
         AND booking_status IN ('Booked', 'Charging')
       FOR UPDATE`,
      [String(stationId), date, time]
    );

    if (existingSlot.rows.length > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message:
          "This slot was booked by another customer. Contact support for a refund.",
      });
    }

    /*
      6. Calculate marketplace split.
    */
    const commissionRate = 0.1;

    const platformCommission = Number(
      (expectedAmount * commissionRate).toFixed(2)
    );

    const ownerAmount = Number(
      (expectedAmount - platformCommission).toFixed(2)
    );

    /*
      7. Create booking only after all verification passes.
    */
    const bookingResult = await client.query(
      `INSERT INTO bookings (
        user_id,
        station_id,
        station_name,
        date,
        time,
        vehicle,
        duration,
        payment_id,
        order_id,
        payment_status,
        booking_status,
        amount_paid,
        platform_commission,
        owner_amount,
        price_per_unit
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,
        'success','Booked',$10,$11,$12,$13
      )
      RETURNING *`,
      [
        userId,
        String(stationId),
        stationName,
        date,
        time,
        vehicle.trim(),
        numericDuration,
        razorpayPaymentId,
        razorpayOrderId,
        expectedAmount,
        platformCommission,
        ownerAmount,
        0,
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Payment verified and booking confirmed",
      booking: bookingResult.rows[0],
      payment: {
        amountPaid: expectedAmount,
        platformCommission,
        ownerAmount,
      },
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("ROLLBACK ERROR:", rollbackError);
    }

    console.error("VERIFY PAYMENT AND BOOK ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Could not verify payment and create booking",
    });
  } finally {
    client.release();
  }
});

/* ================= HISTORY ================= */

app.get("/my-bookings/:id", async(req,res)=>{

try {

const userId = req.params.id;

const result = await pool.query(
`
SELECT 
b.*,

CASE 
WHEN r.id IS NOT NULL 
THEN true
ELSE false
END AS has_review,

r.rating,
r.review

FROM bookings b

LEFT JOIN reviews r
ON r.booking_id = b.id

WHERE b.user_id=$1

ORDER BY b.id DESC
`,
[userId]
);


console.log("HISTORY DATA:");
console.log(result.rows);


res.json(result.rows);


}
catch(error){

console.log(error);

res.status(500).json({
message:"Could not fetch bookings"
});

}

});
/* ================= CANCEL ================= */

app.delete("/cancel-booking/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM bookings WHERE id=$1 RETURNING *",
      [req.params.id]
    );

    res.json({ message: "Cancelled", booking: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: "Cancel failed" });
  }
});

/* ================= RAZORPAY ORDER ================= */
/* ================= SECURE RAZORPAY ORDER ================= */

const SLOT_PRICES = {
  30: 120,
  60: 220,
  120: 400,
};

app.post("/create-order", async (req, res) => {
  try {
    const { duration } = req.body;

    const numericDuration = Number(duration);
    const amount = SLOT_PRICES[numericDuration];

    if (!amount) {
      return res.status(400).json({
        success: false,
        message: "Invalid charging duration",
      });
    }

    const order = await razorpay.orders.create({
      amount: amount * 100, // Razorpay uses paise
      currency: "INR",
      receipt: `plug_${Date.now()}`,
      notes: {
        duration: String(numericDuration),
        amount_rupees: String(amount),
      },
    });

    return res.status(201).json({
      success: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
      },
    });
  } catch (error) {
    console.error("CREATE ORDER ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Could not create payment order",
    });
  }
});

/* ================= VERIFY QR ================= */

app.post("/verify-qr", async (req, res) => {
  try {
    const { bookingId } = req.body;

    const result = await pool.query(
      "SELECT * FROM bookings WHERE id=$1",
      [bookingId]
    );

    if (!result.rows.length) {
      return res.json({ success: false, message: "Not found" });
    }

    const booking = result.rows[0];

    if (booking.payment_status !== "success") {
      return res.json({ success: false, message: "Payment pending" });
    }

    res.json({ success: true, booking });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

/* ================= START CHARGING ================= */

app.post("/start-charging/:bookingId", async (req, res) => {
  try {
    const { bookingId } = req.params;

    const bookingResult = await pool.query(
      `SELECT * FROM bookings WHERE id = $1`,
      [bookingId]
    );

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    const booking = bookingResult.rows[0];

    if (booking.payment_status !== "success") {
      return res.status(400).json({
        success: false,
        message: "Payment is not completed",
      });
    }

    if (booking.booking_status === "Completed") {
      return res.status(400).json({
        success: false,
        message: "This charging session is already completed",
      });
    }

    // Prevent scanning the same QR from restarting the timer.
    if (
      booking.booking_status === "Charging" &&
      booking.charging_start_time &&
      booking.charging_end_time
    ) {
      return res.json({
        success: true,
        message: "Charging is already active",
        booking,
      });
    }

    const duration = Number(booking.duration);

    if (![30, 60, 120].includes(duration)) {
      return res.status(400).json({
        success: false,
        message: "Invalid charging duration",
      });
    }

    const startTime = new Date();
    const endTime = new Date(
      startTime.getTime() + duration * 60 * 1000
    );

    const result = await pool.query(
      `
      UPDATE bookings
      SET
        booking_status = 'Charging',
        charging_start_time = $1,
        charging_end_time = $2
      WHERE id = $3
      RETURNING *
      `,
      [startTime, endTime, bookingId]
    );

    return res.json({
      success: true,
      message: "Charging started",
      booking: result.rows[0],
    });
  } catch (error) {
    console.error("START CHARGING ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to start charging",
    });
  }
});
/* ================= COMPLETE CHARGING (ONLY ONE) ================= */

// Get one booking and return all charging-summary details
app.get("/booking/:bookingId", async (req, res) => {
  try {
    const { bookingId } = req.params;

    let result = await pool.query(
      `
      SELECT
        id,
        user_id,
        station_id,
        station_name,
        date,
        time,
        vehicle,
        duration,
        payment_id,
        order_id,
        payment_status,
        booking_status,
        charging_start_time,
        charging_end_time,
        charging_status,
        created_at,
        amount_paid,
        platform_commission,
        owner_amount,
        units_consumed,
        price_per_unit
      FROM bookings
      WHERE id = $1
      `,
      [bookingId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    let booking = result.rows[0];

    // Automatically mark the charging session as completed
    // when its charging end time has passed.
    if (
      String(booking.booking_status || "").toLowerCase() === "charging" &&
      booking.charging_end_time &&
      new Date(booking.charging_end_time).getTime() <= Date.now()
    ) {
      result = await pool.query(
        `
        UPDATE bookings
        SET
          booking_status = 'Completed',
          charging_status = 'completed'
        WHERE id = $1
        RETURNING
          id,
          user_id,
          station_id,
          station_name,
          date,
          time,
          vehicle,
          duration,
          payment_id,
          order_id,
          payment_status,
          booking_status,
          charging_start_time,
          charging_end_time,
          charging_status,
          created_at,
          amount_paid,
          platform_commission,
          owner_amount,
          units_consumed,
          price_per_unit
        `,
        [bookingId]
      );

      booking = result.rows[0];
    }

    return res.json({
      success: true,
      booking,
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    console.error("GET BOOKING ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load booking",
    });
  }
});


// Complete a charging session
app.put("/complete-charging/:bookingId", async (req,res)=>{

try{

const {bookingId}=req.params;


const result = await pool.query(

`
UPDATE bookings

SET

booking_status='Completed',

charging_status='completed',

charging_end_time=NOW()

WHERE id=$1

RETURNING *

`,

[bookingId]

);



if(result.rows.length===0){

return res.status(404).json({

success:false,

message:"Booking not found"

});

}



res.json({

success:true,

message:"Charging completed successfully",

booking:result.rows[0]

});


}

catch(error){

console.log(error);


res.status(500).json({

success:false,

message:"Failed"

});


}


});

/* ================= STATIONS ================= */

app.get("/stations", async (req, res) => {
  const result = await pool.query(`SELECT * FROM stations ORDER BY id`);
  res.json(result.rows);
});

/* ================= AUTH ================= */

app.post("/signup", async (req, res) => {
  console.log("🔥 SIGNUP HIT");
console.log(req.body);
  try {

    console.log("SIGNUP REQUEST:", req.body);

    const { name, email, phone, password } = req.body;

    const hash = await bcrypt.hash(password, 10);

    const user = await pool.query(
      `INSERT INTO users(name,email,phone,password)
       VALUES($1,$2,$3,$4)
       RETURNING id,name,email`,
      [name, email, phone, hash]
    );

    res.json({
      success: true,
      message: "Signup successful",
      user: user.rows[0]
    });

  } catch(error){
    console.log(error.stack);

    res.status(500).json({
        message: error.message
    });
}
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await pool.query("SELECT * FROM users WHERE email=$1", [email]);

  if (!user.rows.length) return res.status(400).json({ message: "No user" });

  const ok = await bcrypt.compare(password, user.rows[0].password);

  if (!ok) return res.status(400).json({ message: "Wrong password" });

  const token = jwt.sign({ id: user.rows[0].id }, process.env.JWT_SECRET);

  res.json({ token, user: user.rows[0] });
});

/* ================= SAVE PUSH TOKEN (STEP 5 FIX) ================= */

app.post("/save-push-token", async (req, res) => {
  try {
    const { userId, expoPushToken } = req.body;

    await pool.query(
      "UPDATE users SET expo_push_token=$1 WHERE id=$2",
      [expoPushToken, userId]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});


/* ================= OWNER DASHBOARD ================= */

app.get("/owner/stations/:ownerId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *
       FROM stations
       WHERE owner_id = $1
       ORDER BY id`,
      [req.params.ownerId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("OWNER STATIONS ERROR:", error);

    res.status(500).json({
      message: "Could not fetch owner stations",
    });
  }
});

app.get("/owner/bookings/:ownerId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         b.*,
         u.name AS customer_name,
         u.email AS customer_email
       FROM bookings b
       JOIN stations s
         ON s.id::text = b.station_id::text
       LEFT JOIN users u
         ON u.id::text = b.user_id::text
       WHERE s.owner_id::text = $1::text
       ORDER BY b.created_at DESC`,
      [req.params.ownerId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("OWNER BOOKINGS ERROR:", error);

    res.status(500).json({
      message: "Could not fetch owner bookings",
      error: error.message,
    });
  }
});

app.get("/owner/revenue/:ownerId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         COUNT(*)::int AS total_bookings,

         COUNT(*) FILTER (
           WHERE LOWER(b.payment_status) = 'success'
         )::int AS paid_bookings,

         COUNT(*) FILTER (
           WHERE LOWER(b.booking_status) = 'booked'
         )::int AS booked_sessions,

         COUNT(*) FILTER (
           WHERE LOWER(b.booking_status) = 'charging'
         )::int AS charging_sessions,

         COUNT(*) FILTER (
           WHERE LOWER(b.booking_status) = 'completed'
         )::int AS completed_sessions,

         COALESCE(
           SUM(
             CASE
               WHEN LOWER(b.payment_status) = 'success'
               THEN 25
               ELSE 0
             END
           ),
           0
         )::numeric(10,2) AS revenue

       FROM bookings b
       JOIN stations s
         ON s.id::text = b.station_id::text
       WHERE s.owner_id::text = $1::text`,
      [req.params.ownerId]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("OWNER REVENUE ERROR:", error);

    res.status(500).json({
      message: "Could not fetch owner revenue",
      error: error.message,
    });
  }
});

app.put("/owner/start-charging/:bookingId", async (req, res) => {
  try {
    const bookingResult = await pool.query(
      `SELECT *
       FROM bookings
       WHERE id = $1`,
      [req.params.bookingId]
    );

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    const duration = Number(
      bookingResult.rows[0].duration || 30
    );

    const startTime = new Date();
    const endTime = new Date(
      startTime.getTime() + duration * 60000
    );

    const result = await pool.query(
      `UPDATE bookings
       SET
         booking_status = 'Charging',
         charging_status = 'charging',
         charging_start_time = $1,
         charging_end_time = $2
       WHERE id = $3
       RETURNING *`,
      [startTime, endTime, req.params.bookingId]
    );

    res.json({
      success: true,
      booking: result.rows[0],
    });
  } catch (error) {
    console.error("OWNER START CHARGING ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Could not start charging",
    });
  }
});

app.put("/owner/complete-charging/:bookingId", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE bookings
       SET
         booking_status = 'Completed',
         charging_status = 'completed',
         charging_end_time = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [req.params.bookingId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    res.json({
      success: true,
      booking: result.rows[0],
    });
  } catch (error) {
    console.error("OWNER COMPLETE CHARGING ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Could not complete charging",
    });
  }
});

/* ================= ADMIN DASHBOARD ================= */

app.get("/admin/dashboard", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         COUNT(*)::int AS total_bookings,

         COUNT(*) FILTER (
           WHERE booking_status = 'Booked'
         )::int AS booked,

         COUNT(*) FILTER (
           WHERE booking_status = 'Charging'
         )::int AS charging,

         COUNT(*) FILTER (
           WHERE booking_status = 'Completed'
         )::int AS completed,

         COUNT(*) FILTER (
           WHERE payment_status != 'success'
              OR payment_status IS NULL
         )::int AS pending_payments,

         COALESCE(
           SUM(
             CASE
               WHEN payment_status = 'success'
               THEN duration::numeric * 10
               ELSE 0
             END
           ),
           0
         )::numeric(10,2) AS revenue

       FROM bookings`
    );

    const row = result.rows[0];

    res.json({
      totalBookings: row.total_bookings,
      booked: row.booked,
      charging: row.charging,
      completed: row.completed,
      pendingPayments: row.pending_payments,
      revenue: row.revenue,
    });
  } catch (error) {
    console.error("ADMIN DASHBOARD ERROR:", error);

    res.status(500).json({
      message: "Could not load admin dashboard",
    });
  }
});

app.get("/admin/stations", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         s.*,
         u.name AS owner_name,
         u.email AS owner_email
       FROM stations s
       LEFT JOIN users u ON u.id = s.owner_id
       ORDER BY s.id DESC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error("ADMIN STATIONS ERROR:", error);

    res.status(500).json({
      message: "Could not fetch stations",
    });
  }
});

app.put("/admin/approve-station/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE stations
       SET approval_status = 'Approved'
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    res.json({
      success: true,
      station: result.rows[0],
    });
  } catch (error) {
    console.error("APPROVE STATION ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Could not approve station",
    });
  }
});

app.put("/admin/reject-station/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE stations
       SET approval_status = 'Rejected'
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    res.json({
      success: true,
      station: result.rows[0],
    });
  } catch (error) {
    console.error("REJECT STATION ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Could not reject station",
    });
  }
});
// GET ALL CUSTOMER BOOKINGS FOR ADMIN


app.get("/admin/bookings", async (req,res)=>{

  try {

    const result = await pool.query(`
      SELECT
        id,
        station_name,
        vehicle,
        time,
        payment_status,
        booking_status,
        date,
        duration
      FROM bookings
      ORDER BY id DESC
    `);

    console.log("BOOKINGS:", result.rows);

    res.json(result.rows);

  } catch(error){

    console.log("BOOKING ERROR:", error.message);

    res.status(500).json({
      message:"Could not fetch bookings"
    });

  }

});
// ===========================
// SUBMIT REVIEW
// ===========================
app.post("/reviews", async (req,res)=>{

try {

console.log("REVIEW BODY:", req.body);


const {
booking_id,
station_id,
user_id,
rating,
review
} = req.body || {};

    // Basic validation
    if (
      !booking_id ||
      !station_id ||
      !user_id ||
      !rating
    ) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: "Rating must be between 1 and 5",
      });
    }

    // Prevent duplicate review
    const existingReview = await pool.query(
      `
      SELECT id
      FROM reviews
      WHERE booking_id = $1
      `,
      [booking_id]
    );

    if (existingReview.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Review already submitted",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO reviews
      (
        booking_id,
        station_id,
        user_id,
        rating,
        review
      )
      VALUES
      ($1,$2,$3,$4,$5)
      RETURNING *
      `,
      [
        booking_id,
        station_id,
        user_id,
        rating,
        review || "",
      ]
    );

    res.json({
      success: true,
      message: "Review submitted successfully",
      review: result.rows[0],
    });

  } catch (error) {
    console.error("SUBMIT REVIEW ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});
// ================= OWNER DASHBOARD =================

app.get("/owner-dashboard/:ownerId", async (req,res)=>{

    try{

        const ownerId = req.params.ownerId;


        // stations owned by owner
        const stations = await pool.query(
            `
            SELECT *
            FROM stations
            WHERE owner_id=$1
            `,
            [ownerId]
        );


        const stationIds = stations.rows.map(
            station=>station.id
        );


        if(stationIds.length===0){
            return res.json({
                message:"No stations found"
            });
        }



        const bookings = await pool.query(
            `
            SELECT *
            FROM bookings
            WHERE station_id = ANY($1)
            ORDER BY created_at DESC
            `,
            [stationIds]
        );



        const revenue = bookings.rows.reduce(
            (sum,item)=>sum + Number(item.owner_amount || 0),
            0
        );


        const reviews = await pool.query(
            `
            SELECT AVG(rating) as average,
            COUNT(*) as total
            FROM reviews
            WHERE station_id = ANY($1)
            `,
            [stationIds]
        );



        res.json({

            stations: stations.rows,

            total_stations:
            stations.rows.length,


            total_bookings:
            bookings.rows.length,


            revenue: revenue,


            average_rating:
            reviews.rows[0].average || 0,


            total_reviews:
            reviews.rows[0].total || 0,


            recent_bookings:
            bookings.rows.slice(0,5)

        });


    }
    catch(error){

        console.log(error);

        res.status(500).json({
            message:"Dashboard error"
        });

    }

});
// ADD NEW STATION BY OWNER
app.post("/owner/add-station", async (req, res) => {
  try {

    const {
      ownerId,
      name,
      address,
      latitude,
      longitude,
      chargerType,
      pricePerKwh,
      totalSlots
    } = req.body;


    const result = await pool.query(
      `
      INSERT INTO stations
      (
        owner_id,
        name,
        address,
        latitude,
        longitude,
        charger_type,
        price_per_kwh,
        total_slots,
        approval_status
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,'Approved')
      RETURNING *
      `,
      [
        ownerId,
        name,
        address,
        latitude,
        longitude,
        chargerType,
        pricePerKwh,
        totalSlots
      ]
    );


    res.json({
      message:"Station added successfully",
      station:result.rows[0]
    });


  } catch(error){

    console.log("ADD STATION ERROR:",error);

    res.status(500).json({
      message:"Could not add station"
    });

  }
});
// UPDATE OWNER STATION
app.put("/owner/update-station/:id", async (req,res)=>{

  try {

    const stationId = req.params.id;

    const {
      name,
      address,
      latitude,
      longitude,
      chargerType,
      pricePerKwh,
      totalSlots
    } = req.body;


    const result = await pool.query(
      `
      UPDATE stations
      SET
      name=$1,
      address=$2,
      latitude=$3,
      longitude=$4,
      charger_type=$5,
      price_per_kwh=$6,
      total_slots=$7

      WHERE id=$8

      RETURNING *
      `,
      [
        name,
        address,
        latitude,
        longitude,
        chargerType,
        pricePerKwh,
        totalSlots,
        stationId
      ]
    );


    res.json({
      message:"Station updated successfully",
      station:result.rows[0]
    });


  } catch(error){

    console.log("UPDATE STATION ERROR:",error);

    res.status(500).json({
      message:"Could not update station"
    });

  }

});
// DELETE OWNER STATION
app.delete("/owner/delete-station/:id", async(req,res)=>{

try{

const stationId=req.params.id;


await pool.query(
"DELETE FROM stations WHERE id=$1",
[stationId]
);


res.json({
message:"Station deleted successfully"
});


}catch(error){

console.log("DELETE ERROR:",error);

res.status(500).json({
message:"Could not delete station"
});

}

});
// UPDATE STATION BY OWNER
app.put("/owner/update-station/:id", async (req,res)=>{
  try{

    const {
      name,
      address,
      chargerType,
      pricePerKwh,
      totalSlots
    } = req.body;


    const result = await pool.query(
      `
      UPDATE stations
      SET
      name=$1,
      address=$2,
      charger_type=$3,
      price_per_kwh=$4,
      total_slots=$5
      WHERE id=$6
      RETURNING *
      `,
      [
        name,
        address,
        chargerType,
        pricePerKwh,
        totalSlots,
        req.params.id
      ]
    );


    res.json({
      message:"Station updated successfully",
      station:result.rows[0]
    });


  }catch(error){

    console.log(error);

    res.status(500).json({
      message:"Update failed"
    });

  }
});
// DELETE STATION BY OWNER
app.delete("/owner/delete-station/:id", async (req,res)=>{

  try {

    const stationId = req.params.id;

    const result = await pool.query(
      `
      DELETE FROM stations
      WHERE id=$1
      RETURNING *
      `,
      [stationId]
    );


    if(result.rows.length === 0){
      return res.status(404).json({
        message:"Station not found"
      });
    }


    res.json({
      message:"Station deleted successfully",
      station:result.rows[0]
    });


  } catch(error){

    console.log("DELETE STATION ERROR:", error);

    res.status(500).json({
      message:"Delete failed"
    });

  }

});
// GET PENDING STATIONS FOR ADMIN

app.get("/admin/pending-stations", async(req,res)=>{
  try{

    const result = await pool.query(
`
SELECT 
stations.*,
users.name AS owner_name,
users.email AS owner_email

FROM stations

LEFT JOIN users
ON stations.owner_id = users.id

WHERE stations.approval_status='Pending'

ORDER BY stations.id DESC
`
);

    res.json(result.rows);

  }catch(error){

    console.log(error);

    res.status(500).json({
      message:"Could not fetch pending stations"
    });

  }
});



// APPROVE STATION

app.put("/admin/approve-station/:id", async(req,res)=>{

try{

 const result = await pool.query(
 `
 UPDATE stations
 SET approval_status='Approved'
 WHERE id=$1
 RETURNING *
 `,
 [req.params.id]
 );


 res.json({
   message:"Station approved successfully",
   station:result.rows[0]
 });


}catch(error){

console.log(error);

res.status(500).json({
 message:"Approval failed"
});

}

});



// REJECT STATION

app.put("/admin/reject-station/:id", async(req,res)=>{

try{

 const result = await pool.query(
 `
 UPDATE stations
 SET approval_status='Rejected'
 WHERE id=$1
 RETURNING *
 `,
 [req.params.id]
 );


 res.json({
   message:"Station rejected",
   station:result.rows[0]
 });


}catch(error){

console.log(error);

res.status(500).json({
 message:"Reject failed"
});

}

});
// ================= ADMIN STATION APPROVAL =================


// GET PENDING STATIONS

app.get("/admin/pending-stations", async(req,res)=>{

try{

const result = await pool.query(
`
SELECT *
FROM stations
WHERE approval_status='Pending'
ORDER BY id DESC
`
);

res.json(result.rows);


}catch(error){

console.log(error);

res.status(500).json({
message:"Could not fetch pending stations"
});

}

});




// APPROVE STATION

app.put("/admin/approve-station/:id", async(req,res)=>{

try{


const result = await pool.query(

`
UPDATE stations
SET approval_status='Approved'
WHERE id=$1
RETURNING *
`,

[req.params.id]

);


res.json({

message:"Station approved successfully",

station:result.rows[0]

});


}catch(error){

console.log(error);

res.status(500).json({

message:"Approval failed"

});

}

});




// REJECT STATION

app.put("/admin/reject-station/:id", async(req,res)=>{


try{


const result = await pool.query(

`
UPDATE stations
SET approval_status='Rejected'
WHERE id=$1
RETURNING *
`,

[req.params.id]

);


res.json({

message:"Station rejected",

station:result.rows[0]

});


}catch(error){

console.log(error);


res.status(500).json({

message:"Reject failed"

});


}

});
/* ================= START SERVER ================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});