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

app.post("/book-slot", async (req, res) => {
  try {
    const {
      userId,
      stationId,
      stationName,
      date,
      time,
      vehicle,
      duration,
      paymentId,
      orderId,
      paymentStatus,
    } = req.body;

    if (!userId || !stationId || !date || !time) {
      return res.status(400).json({ message: "Missing booking details" });
    }

    // check slot
    const existing = await pool.query(
      `SELECT * FROM bookings WHERE station_id=$1 AND date=$2 AND time=$3`,
      [stationId, date, time]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ message: "Slot already booked" });
    }

    const result = await pool.query(
      `INSERT INTO bookings 
      (user_id, station_id, station_name, date, time, vehicle, duration, payment_id, order_id, payment_status, booking_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Booked')
      RETURNING *`,
      [
        userId,
        stationId,
        stationName,
        date,
        time,
        vehicle,
        duration,
        paymentId,
        orderId,
        paymentStatus || "success",
      ]
    );

    res.status(201).json({
      message: "Booking confirmed",
      booking: result.rows[0],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Booking failed" });
  }
});

/* ================= HISTORY ================= */

app.get("/my-bookings/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM bookings WHERE user_id=$1 ORDER BY created_at DESC`,
      [req.params.userId]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: "Error fetching history" });
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

app.post("/create-order", async (req, res) => {
  try {
    const { amount } = req.body;

    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
    });

    res.json(order);
  } catch (err) {
    res.status(500).json({ message: "Order failed" });
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

app.put("/start-charging/:bookingId", async (req,res)=>{

try{

const { bookingId } = req.params;


// get booking
const booking = await pool.query(
`
SELECT *
FROM bookings
WHERE id=$1
`,
[bookingId]
);


if(booking.rows.length===0){

return res.json({
success:false,
message:"Booking not found"
});

}


const duration = Number(
booking.rows[0].duration || 30
);


// current time
const startTime = new Date();


// ending time
const endTime = new Date(
startTime.getTime() + duration*60000
);



const result = await pool.query(
`
UPDATE bookings

SET 
booking_status='Charging',
charging_start_time=$1,
charging_end_time=$2

WHERE id=$3

RETURNING *
`,
[
startTime,
endTime,
bookingId
]
);



res.json({

success:true,

message:"Charging started",

booking:result.rows[0]

});


}
catch(error){

console.log(error);

res.status(500).json({
success:false,
message:"Failed to start charging"
});

}

});
/* ================= COMPLETE CHARGING (ONLY ONE) ================= */

app.put("/complete-charging/:bookingId", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE bookings SET booking_status='Completed'
       WHERE id=$1 RETURNING *`,
      [req.params.bookingId]
    );

    res.json({ success: true, booking: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: "Failed" });
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
app.get("/booking/:bookingId", async (req, res) => {
  try {
    const { bookingId } = req.params;

    const result = await pool.query(
      "SELECT * FROM bookings WHERE id = $1",
      [bookingId]
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
    console.error("Booking API Error:", error);

    res.status(500).json({
      success: false,
      message: "Server Error",
    });
  }
});
app.get("/booking/:bookingId", async (req, res) => {
  try {
    const { bookingId } = req.params;

    const result = await pool.query(
      "SELECT * FROM bookings WHERE id = $1",
      [bookingId]
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
    console.error("BOOKING FETCH ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Could not fetch booking",
    });
  }
});
/* ================= START SERVER ================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});