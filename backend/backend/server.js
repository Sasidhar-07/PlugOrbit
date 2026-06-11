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
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

app.use(cors());
app.use(express.json());

// Debugger: This will print EVERY request to your terminal
app.use((req, res, next) => {
  console.log(`${req.method} request made to: ${req.url}`);
  next();
});

app.get("/", (req, res) => res.json({ message: "PlugOrbit Online" }));

app.get("/bookings", async (req, res) => {
  try {
    const result = await pool.query(
      
      "SELECT * FROM bookings ORDER BY id DESC"
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching bookings:", error.message);
    res.status(500).json({ message: "Server error" });
  }
});

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
   

    console.log("📥 Data Received:", req.body);

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    // Check if slot already booked
    const existing = await pool.query(
      `SELECT * FROM bookings 
       WHERE station_id=$1 AND date=$2 AND time=$3`,
      [stationId, date, time]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ message: "Slot already booked" });
    }

    // Insert booking with user_id
    const newBooking = await pool.query(
  `INSERT INTO bookings 
   (user_id, station_id, station_name, date, time, vehicle, duration, payment_id, order_id, payment_status)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
      message: "Booking confirmed!",
      booking: newBooking.rows[0],
    });
  } catch (error) {
    console.error("❌ DATABASE ERROR:", error.message);
    res.status(500).json({ message: error.message });
  }
});
app.get("/history/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      `SELECT * FROM bookings
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("History error:", error);
    res.status(500).json({ message: "Failed to fetch history" });
  }
});
app.get("/booked-slots", async (req, res) => {
  try {
    const { stationId, date } = req.query;

    const result = await pool.query(
      `SELECT time, duration FROM bookings
       WHERE station_id = $1 AND date = $2`,
      [stationId, date]
    );

    const blockedSlots = [];

    result.rows.forEach((booking) => {
      const [hour, minute] = booking.time.split(":").map(Number);
      const startMinutes = hour * 60 + minute;
      const duration = Number(booking.duration || 30);

      for (let i = 0; i < duration; i += 30) {
        const totalMinutes = startMinutes + i;
        const h = Math.floor(totalMinutes / 60) % 24;
        const m = totalMinutes % 60;

        blockedSlots.push(
          `${h.toString().padStart(2, "0")}:${m
            .toString()
            .padStart(2, "0")}`
        );
      }
    });

    res.json(blockedSlots);
  } catch (error) {
    console.error("Booked slots error:", error);
    res.status(500).json({ message: "Failed to fetch booked slots" });
  }
});

app.delete("/bookings/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      "DELETE FROM bookings WHERE id = $1 RETURNING *",
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Booking not found",
      });
    }

    res.json({
      message: "Booking cancelled successfully",
      booking: result.rows[0],
    });
  } catch (error) {
    console.error("Cancel booking error:", error);
    res.status(500).json({
      message: "Failed to cancel booking",
    });
  }
});
app.post("/signup", async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    const existingUser = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        message: "Email already exists",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await pool.query(
      `INSERT INTO users(name,email,phone,password)
       VALUES($1,$2,$3,$4)
       RETURNING id,name,email`,
      [name, email, phone, hashedPassword]
    );

    res.status(201).json({
      message: "Signup successful",
      user: user.rows[0],
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Signup failed",
    });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (user.rows.length === 0) {
      return res.status(400).json({
        message: "User not found",
      });
    }

    const validPassword = await bcrypt.compare(
      password,
      user.rows[0].password
    );

    if (!validPassword) {
      return res.status(400).json({
        message: "Invalid password",
      });
    }

    const token = jwt.sign(
      { id: user.rows[0].id },
      process.env.JWT_SECRET
    );

    res.json({
  message: "Login successful",
  token,
  user: {
    id: user.rows[0].id,
    name: user.rows[0].name,
    email: user.rows[0].email,
    role: user.rows[0].role,
  },
});
    
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Login failed",
    });
  }
});

app.get("/stations", async (req, res) => {
  const result = await pool.query(`
    SELECT
      id,
      name,
      address,
      latitude,
      longitude,
      charger_type,
      price_per_kwh,
      total_slots
    FROM stations
    ORDER BY id ASC
  `);

  res.json(result.rows);
});
app.get("/station-status", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        stations.id,
        stations.total_slots,
        LEAST(COUNT(bookings.id), stations.total_slots) AS occupied_chargers,
        GREATEST(stations.total_slots - COUNT(bookings.id), 0) AS available_chargers
      FROM stations
      LEFT JOIN bookings
        ON stations.id::text = bookings.station_id
        AND bookings.date >= CURRENT_DATE
      GROUP BY stations.id, stations.total_slots
      ORDER BY stations.id
    `);

    res.json(result.rows);
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Failed to fetch station status" });
  }
});
app.delete("/cancel-booking/:id", async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(
      "DELETE FROM bookings WHERE id = $1",
      [id]
    );

    res.json({
      success: true,
      message: "Booking cancelled successfully",
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      message: "Failed to cancel booking",
    });
  }
});
app.post("/create-order", async (req, res) => {
  try {
    const { amount } = req.body;

    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt: `receipt_${Date.now()}`
    });

    res.json(order);
  } catch (err) {
    console.log(err);
    res.status(500).json({
      message: "Order creation failed"
    });
  }
});
app.get("/my-bookings/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      `SELECT *
       FROM bookings
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("History error:", err);
    res.status(500).json({ message: "Server error" });
  }
});
app.post("/verify-qr", async (req, res) => {
  try {
    const { bookingId } = req.body;

    if (!bookingId) {
      return res.status(400).json({
        success: false,
        message: "Booking ID is required",
      });
    }

    const result = await pool.query(
      `SELECT *
       FROM bookings
       WHERE id = $1`,
      [bookingId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    const booking = result.rows[0];

    if (booking.payment_status !== "success") {
      return res.status(400).json({
        success: false,
        message: "Payment not completed",
      });
    }

    res.json({
      success: true,
      message: "Booking verified successfully",
      booking,
    });
  } catch (error) {
    console.error("QR verify error:", error);
    res.status(500).json({
      success: false,
      message: "QR verification failed",
    });
  }
});
app.post("/start-charging/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE bookings
       SET booking_status = 'Charging'
       WHERE id = $1
       RETURNING *`,
      [id]
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
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Failed to start charging",
    });
  }
});
app.post("/complete-charging/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE bookings
       SET booking_status = 'Completed'
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    res.json({
      success: true,
      message: "Charging completed",
      booking: result.rows[0],
    });
  } catch (error) {
    console.error("Complete charging error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to complete charging",
    });
  }
});
app.get("/admin/dashboard", async (req, res) => {
  try {
    const totalBookings = await pool.query(
      "SELECT COUNT(*) FROM bookings"
    );

    const booked = await pool.query(
      "SELECT COUNT(*) FROM bookings WHERE booking_status = 'Booked' AND payment_status = 'success'"
    );

    const charging = await pool.query(
      "SELECT COUNT(*) FROM bookings WHERE booking_status = 'Charging'"
    );

    const completed = await pool.query(
      "SELECT COUNT(*) FROM bookings WHERE booking_status = 'Completed'"
    );

   const pendingPayments = await pool.query(
  "SELECT COUNT(*) FROM bookings WHERE payment_status != 'success'"
);

const revenue = await pool.query(`
  SELECT COALESCE(
    SUM(duration * 10),
    0
  ) AS revenue
  FROM bookings
  WHERE payment_status = 'success'
`);


    res.json({
      totalBookings: Number(totalBookings.rows[0].count),
      booked: Number(booked.rows[0].count),
      charging: Number(charging.rows[0].count),
      completed: Number(completed.rows[0].count),
      pendingPayments: Number(pendingPayments.rows[0].count),
      revenue: Number(revenue.rows[0].revenue),
    });
  } catch (error) {
    console.error("Admin dashboard error:", error);
    res.status(500).json({
      message: "Failed to load dashboard",
    });
  }
});
app.get("/admin/bookings", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        bookings.id,
        bookings.station_name,
        bookings.vehicle,
        bookings.date,
        bookings.time,
        bookings.duration,
        bookings.payment_status,
        bookings.booking_status,
        users.name AS customer_name,
        users.email AS customer_email
      FROM bookings
      LEFT JOIN users ON bookings.user_id = users.id
      ORDER BY bookings.created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Admin bookings error:", error);
    res.status(500).json({
      message: "Failed to load admin bookings",
    });
  }
});

app.get("/owner/bookings/:ownerId", async (req, res) => {
  try {
    const { ownerId } = req.params;

    const result = await pool.query(
      `
      SELECT b.*, u.name AS customer_name, u.email AS customer_email
      FROM bookings b
      JOIN users u ON b.user_id = u.id
      JOIN stations s ON b.station_id::integer = s.id
      WHERE s.owner_id = $1
      ORDER BY b.created_at DESC
      `,
      [ownerId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to load owner bookings",
    });
  }
});

app.put("/owner/start-charging/:bookingId", async (req, res) => {
  try {
    const { bookingId } = req.params;

    const result = await pool.query(
      `
      UPDATE bookings
      SET booking_status = 'Charging'
      WHERE id = $1
      RETURNING *
      `,
      [bookingId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Booking not found",
      });
    }

    res.json({
      message: "Charging started successfully",
      booking: result.rows[0],
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to start charging",
    });
  }
});

app.put("/owner/complete-charging/:bookingId", async (req, res) => {
  try {
    const { bookingId } = req.params;

    const result = await pool.query(
      `
      UPDATE bookings
      SET booking_status = 'Completed'
      WHERE id = $1
      RETURNING *
      `,
      [bookingId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Booking not found",
      });
    }

    res.json({
      message: "Charging completed successfully",
      booking: result.rows[0],
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to complete charging",
    });
  }
});
app.post("/admin/approve-payment/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE bookings
       SET payment_status = 'success',
           booking_status = 'Booked'
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    res.json({
      success: true,
      message: "Payment approved successfully",
      booking: result.rows[0],
    });
  } catch (error) {
    console.error("Approve payment error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to approve payment",
    });
  }
});
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
      totalSlots,
    } = req.body;

    if (!ownerId || !name || !address || !latitude || !longitude) {
      return res.status(400).json({
        message: "Owner ID, name, address, latitude and longitude are required",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO stations
      (owner_id, name, address, latitude, longitude, charger_type, price_per_kwh, total_slots)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [
        ownerId,
        name,
        address,
        latitude,
        longitude,
        chargerType || "Fast",
        pricePerKwh || 20,
        totalSlots || 5,
      ]
    );

    res.status(201).json({
      message: "Station added successfully",
      station: result.rows[0],
    });
  } catch (error) {
    console.error("Add station error:", error);
    res.status(500).json({
      message: "Failed to add station",
    });
  }
});
 app.get("/owner/stations/:ownerId", async (req, res) => {
  try {
    const { ownerId } = req.params;

    const result = await pool.query(
      `
      SELECT *
      FROM stations
      WHERE owner_id = $1
      ORDER BY id DESC
      `,
      [ownerId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to load stations",
    });
  }
});
app.put("/owner/start-charging/:bookingId", async (req, res) => {
  try {
    const { bookingId } = req.params;

    await pool.query(
      `
      UPDATE bookings
      SET booking_status = 'Charging'
      WHERE id = $1
      `,
      [bookingId]
    );

    res.json({
      message: "Charging started",
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Failed to start charging",
    });
  }
});
app.put("/owner/complete-charging/:bookingId", async (req, res) => {
  try {
    const { bookingId } = req.params;

    await pool.query(
      `
      UPDATE bookings
      SET booking_status = 'Completed'
      WHERE id = $1
      `,
      [bookingId]
    );

    res.json({
      message: "Charging completed",
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Failed to complete charging",
    });
  }
});
app.post("/create-order", async (req, res) => {
  try {
    const { amount } = req.body;

    const options = {
      amount: amount * 100, // Razorpay uses paise
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
    };

    const order = await razorpay.orders.create(options);

    res.json(order);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Failed to create order",
    });
  }
});
app.get("/pay/:amount", async (req, res) => {
  try {
    const amount = Number(req.params.amount);

    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
    });

    res.send(`
    <html>
    <head>
      <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
    </head>
    <body>
      <script>
        var options = {
          key: "${process.env.RAZORPAY_KEY_ID}",
          amount: ${amount * 100},
          currency: "INR",
          name: "PlugOrbit",
          description: "EV Charging Payment",
          order_id: "${order.id}",
          prefill: {
            name: "Sasidhar",
            email: "test@example.com",
            contact: "9999999999"
          },
          handler: function (response) {
            window.location.href =
              "http://192.168.1.7:5001/payment-success?payment_id=" +
              response.razorpay_payment_id;
          },
          theme: {
            color: "#16a34a"
          }
        };

        var rzp = new Razorpay(options);
        rzp.open();
      </script>
    </body>
    </html>
    `);
  } catch (error) {
    console.error(error);
    res.status(500).send("Payment page failed");
  }
});
app.get("/payment-success", async (req, res) => {
  try {
    const {
      payment_id,
      station_id,
      station_name,
      vehicle,
      date,
      time,
      duration,
      user_id,
    } = req.query;

    await pool.query(
      `
      INSERT INTO bookings
      (
        station_id,
        station_name,
        vehicle,
        date,
        time,
        duration,
        user_id,
        payment_id,
        payment_status,
        booking_status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'success','Booked')
      `,
      [
        station_id,
        station_name,
        vehicle,
        date,
        time,
        duration,
        user_id,
        payment_id,
      ]
    );

    res.send(`
      <html>
        <body style="font-family: Arial; text-align: center; padding-top: 80px;">
          <h1 style="color: green;">Booking Confirmed ✅</h1>
          <p>Payment successful and slot booked.</p>
          <p>Payment ID: ${payment_id}</p>
          <p>You can go back to PlugOrbit app.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Payment success booking error:", error);

    res.send(`
      <html>
        <body style="font-family: Arial; text-align: center; padding-top: 80px;">
          <h1 style="color: red;">Payment Done, Booking Failed ❌</h1>
          <p>Please contact PlugOrbit support.</p>
        </body>
      </html>
    `);
  }
});
app.get("/owner/revenue/:ownerId", async (req, res) => {
  try {
    const { ownerId } = req.params;

    const result = await pool.query(
      `
      SELECT
        COUNT(*) as total_bookings,
        COUNT(*) FILTER (WHERE b.booking_status = 'Completed') as completed_sessions,
        COUNT(*) FILTER (WHERE b.booking_status = 'Charging') as charging_sessions,
        COUNT(*) FILTER (WHERE b.booking_status = 'Booked') as booked_sessions,
        COUNT(*) FILTER (WHERE b.payment_status = 'success') as paid_bookings
      FROM bookings b
      JOIN stations s
      ON b.station_id::integer = s.id
      WHERE s.owner_id = $1
      `,
      [ownerId]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Revenue API error:", error);
    res.status(500).json({
      message: "Failed to fetch revenue data",
    });
  }
});
app.get("/admin/stations", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, u.name AS owner_name, u.email AS owner_email
      FROM stations s
      LEFT JOIN users u ON s.owner_id = u.id
      ORDER BY s.id DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Admin stations error:", error);
    res.status(500).json({ message: "Failed to load stations" });
  }
});

app.put("/admin/approve-station/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      UPDATE stations
      SET approval_status = 'Approved'
      WHERE id = $1
      RETURNING *
      `,
      [id]
    );

    res.json({
      message: "Station approved successfully",
      station: result.rows[0],
    });
  } catch (error) {
    console.error("Approve station error:", error);
    res.status(500).json({ message: "Failed to approve station" });
  }
});

app.put("/admin/reject-station/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      UPDATE stations
      SET approval_status = 'Rejected'
      WHERE id = $1
      RETURNING *
      `,
      [id]
    );

    res.json({
      message: "Station rejected successfully",
      station: result.rows[0],
    });
  } catch (error) {
    console.error("Reject station error:", error);
    res.status(500).json({ message: "Failed to reject station" });
  }
});
app.post("/verify-qr", async (req, res) => {
  try {
    const { bookingId } = req.body;

    const result = await pool.query(
      `
      SELECT *
      FROM bookings
      WHERE id = $1
      `,
      [bookingId]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: false,
        message: "Booking not found",
      });
    }

    const booking = result.rows[0];

    if (booking.payment_status !== "success") {
      return res.json({
        success: false,
        message: "Payment not completed",
      });
    }

    if (booking.booking_status === "Completed") {
      return res.json({
        success: false,
        message: "This booking is already completed",
      });
    }

    res.json({
      success: true,
      booking,
    });
  } catch (error) {
    console.error("Verify QR error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to verify QR",
    });
  }
});

app.post("/start-charging/:bookingId", async (req, res) => {
  try {
    const { bookingId } = req.params;

    const result = await pool.query(
      `
      UPDATE bookings
      SET booking_status = 'Charging'
      WHERE id = $1
      RETURNING *
      `,
      [bookingId]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: false,
        message: "Booking not found",
      });
    }

    res.json({
      success: true,
      message: "Charging started",
      booking: result.rows[0],
    });
  } catch (error) {
    console.error("Start charging QR error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to start charging",
    });
  }
});

app.post("/complete-charging/:bookingId", async (req, res) => {
  try {
    const { bookingId } = req.params;

    const result = await pool.query(
      `
      UPDATE bookings
      SET booking_status = 'Completed'
      WHERE id = $1
      RETURNING *
      `,
      [bookingId]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: false,
        message: "Booking not found",
      });
    }

    res.json({
      success: true,
      message: "Charging completed",
      booking: result.rows[0],
    });
  } catch (error) {
    console.error("Complete charging QR error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to complete charging",
    });
  }
});
app.listen(PORT, "0.0.0.0", () => {
  
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
