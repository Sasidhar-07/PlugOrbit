const express = require("express");
const cors = require("cors");

require("dotenv").config();
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

const pool = require("./db");

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 5001;


// ================= MIDDLEWARE =================

app.use(cors());

app.use(express.json());

app.use(express.urlencoded({
  extended:true
}));


// Debug logger

app.use((req,res,next)=>{

console.log(
`${req.method} ${req.url}`
);

next();

});



// ================= RAZORPAY =================


const razorpay = new Razorpay({

key_id:
process.env.RAZORPAY_KEY_ID,

key_secret:
process.env.RAZORPAY_KEY_SECRET

});



// ================= HOME =================


app.get("/",(req,res)=>{

res.json({
message:"PlugOrbit Online"
});

});




// ================= PRICES =================


const SLOT_PRICES = {

30:120,

60:220,

120:400

};



// =================================================
// AUTH
// =================================================



app.post("/signup",async(req,res)=>{


try{


const {
name,
email,
phone,
password
}=req.body;



const hash =
await bcrypt.hash(password,10);



const result =
await pool.query(

`
INSERT INTO users
(
name,
email,
phone,
password
)

VALUES
($1,$2,$3,$4)

RETURNING id,name,email
`

,
[
name,
email,
phone,
hash
]

);



res.json({

success:true,

user:result.rows[0]

});



}
catch(error){


console.log(error);


res.status(500).json({

success:false,

message:error.message

});


}


});







app.post("/login",async(req,res)=>{


try{


const {
email,
password
}=req.body;



const result =
await pool.query(

`
SELECT *
FROM users
WHERE email=$1
`

,
[email]

);



if(result.rows.length===0)

return res.status(400).json({

message:"No user"

});



const user=result.rows[0];
console.log("LOGIN USER:", user.email);
console.log("ENTERED PASSWORD:", password);
console.log("DATABASE HASH:", user.password);


const valid =
await bcrypt.compare(
password,
user.password
);



if(!valid)

return res.status(400).json({

message:"Wrong password"

});



const token =
jwt.sign(

{
id:user.id
},

process.env.JWT_SECRET

);



res.json({

token,

user

});


}
catch(error){


res.status(500).json({

message:"Login failed"

});


}


});


app.post("/forgot-password", async (req, res) => {
  console.log("FORGOT PASSWORD API CALLED");

  try {
    const email = req.body.email?.trim().toLowerCase();

    if (!email) {
      return res.status(400).json({
        message: "Email is required",
      });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM users
      WHERE LOWER(email) = $1
      `,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        message: "Email not registered",
      });
    }

    const otp = Math.floor(
      100000 + Math.random() * 900000
    ).toString();

    await pool.query(
      `
      UPDATE users
      SET reset_otp = $1,
          reset_otp_expiry = NOW() + INTERVAL '10 minutes'
      WHERE LOWER(email) = $2
      `,
      [otp, email]
    );

    const { data, error } = await resend.emails.send({
      from: "PlugOrbit <onboarding@resend.dev>",
      to: [email],
      subject: "PlugOrbit Password Reset OTP",
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>PlugOrbit Password Reset</h2>

          <p>Your OTP is:</p>

          <h1 style="letter-spacing: 5px;">
            ${otp}
          </h1>

          <p>This OTP is valid for 10 minutes.</p>

          <p>If you did not request this, ignore this email.</p>
        </div>
      `,
    });

    if (error) {
      console.error("RESEND EMAIL ERROR:", error);

      return res.status(500).json({
        message: error.message || "Unable to send OTP",
      });
    }

    console.log("OTP EMAIL SENT:", data?.id);

    return res.json({
      message: "OTP sent to your email",
    });
  } catch (error) {
    console.error("FORGOT PASSWORD ERROR:", error);

    return res.status(500).json({
      message: "Unable to send OTP",
    });
  }
});
// =================================================
// CREATE RAZORPAY ORDER
// =================================================



app.post("/create-order",async(req,res)=>{


try{


const duration =
Number(req.body.duration);



const amount =
SLOT_PRICES[duration];


await transporter.sendMail
if(!amount)

return res.status(400).json({

message:"Invalid duration"

});



const order =
await razorpay.orders.create({

amount:amount*100,

currency:"INR",

receipt:
`plug_${Date.now()}`

});



res.json({

success:true,

order

});


}
catch(error){


console.log(error);


res.status(500).json({

message:"Order creation failed"

});


}


});




// =================================================
// VERIFY PAYMENT + CREATE BOOKING
// =================================================



app.post(
"/verify-payment-and-book",
async(req,res)=>{


const client =
await pool.connect();



try{


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

razorpaySignature


}=req.body;



const amount =
SLOT_PRICES[Number(duration)];



if(!amount)

return res.status(400).json({

message:"Invalid duration"

});



// verify signature


const signature =
crypto
.createHmac(
"sha256",
process.env.RAZORPAY_KEY_SECRET
)

.update(
`${razorpayOrderId}|${razorpayPaymentId}`
)

.digest("hex");



if(signature!==razorpaySignature)

return res.status(400).json({

message:"Payment verification failed"

});




// prevent duplicate booking


const duplicate =
await pool.query(

`
SELECT id
FROM bookings
WHERE payment_id=$1
`,
[
razorpayPaymentId
]

);



if(duplicate.rows.length)

return res.status(400).json({

message:"Booking already exists"

});





const commission =
Number(
(amount*0.1)
.toFixed(2)
);



const ownerAmount =
amount-commission;




const booking =
await client.query(

`
INSERT INTO bookings

(
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
charging_status,
amount_paid,
platform_commission,
owner_amount,
price_per_unit
)

VALUES

(
$1,$2,$3,$4,$5,$6,$7,$8,$9,
'success',
'Booked',
'waiting',
$10,$11,$12,
0
)

RETURNING *

`

,

[

userId,

stationId,

stationName,

date,

time,

vehicle,

duration,

razorpayPaymentId,

razorpayOrderId,

amount,

commission,

ownerAmount

]


);



res.json({

success:true,

booking:booking.rows[0]

});



}
catch(error){


console.log(
"BOOKING ERROR",
error
);



res.status(500).json({

message:"Booking failed"

});


}
finally{


client.release();


}


});




// =================================================
// HISTORY
// =================================================


app.get(
"/my-bookings/:id",
async(req,res)=>{


try{


const result =
await pool.query(

`
SELECT *

FROM bookings

WHERE user_id=$1

ORDER BY id DESC

`

,
[
req.params.id
]

);



res.json(result.rows);



}
catch(error){


res.status(500).json({

message:"History failed"

});


}


});




// =================================================
// GET SINGLE BOOKING FOR QR
// =================================================


app.get(
"/booking/:id",
async(req,res)=>{


try{


const result =
await pool.query(

`
SELECT *
FROM bookings
WHERE id=$1
`

,
[
req.params.id
]

);



if(result.rows.length===0)

return res.status(404).json({

message:"Booking not found"

});



res.json({

success:true,

booking:result.rows[0]

});


}
catch(error){


console.log(error);


res.status(500).json({

message:"Server error"

});


}


});




// =================================================
// VERIFY QR
// =================================================


app.post(
"/verify-qr",
async(req,res)=>{


try{


const {
bookingId
}=req.body;



const result =
await pool.query(

`
SELECT *
FROM bookings
WHERE id=$1
`

,
[
bookingId
]

);



if(result.rows.length===0)

return res.json({

success:false,

message:"Booking not found"

});



const booking =
result.rows[0];



if(
booking.booking_status==="Completed"
)

return res.json({

success:false,

message:"Charging already completed"

});



if(
booking.booking_status==="Charging"
)

return res.json({

success:false,

message:"Charging already started"

});



res.json({

success:true,

booking

});


}
catch(error){


res.status(500).json({

success:false,

message:"QR verification failed"

});


}


});
// =================================================
// START CHARGING
// =================================================


app.post(
"/start-charging/:bookingId",
async(req,res)=>{


try{


const bookingId =
req.params.bookingId;



const result =
await pool.query(

`
SELECT *
FROM bookings
WHERE id=$1
FOR UPDATE
`

,
[
bookingId
]

);



if(result.rows.length===0)

return res.status(404).json({

success:false,

message:"Booking not found"

});



const booking =
result.rows[0];



// payment check

if(
booking.payment_status !== "success"
)

return res.status(400).json({

success:false,

message:"Payment not completed"

});




// prevent duplicate start

if(
booking.booking_status==="Charging"
)

return res.status(400).json({

success:false,

message:"Charging already started"

});



if(
booking.booking_status==="Completed"
)

return res.status(400).json({

success:false,

message:"Charging already completed"

});





const duration =
Number(booking.duration);



const startTime =
new Date();



const endTime =
new Date(
startTime.getTime()
+
duration*60*1000
);





const updated =
await pool.query(

`
UPDATE bookings

SET

booking_status='Charging',

charging_status='charging',

charging_start_time=$1,

charging_end_time=$2

WHERE id=$3

RETURNING *

`

,

[

startTime,

endTime,

bookingId

]

);



res.json({

success:true,

message:"Charging started",

booking:
updated.rows[0]

});



}
catch(error){


console.log(
"START CHARGING ERROR",
error
);



res.status(500).json({

success:false,

message:"Could not start charging"

});


}


});

app.post(
"/complete-charging/:bookingId",
async(req,res)=>{


try{


const bookingId =
req.params.bookingId;



const result =
await pool.query(

`
SELECT *
FROM bookings
WHERE id=$1
`,
[
bookingId
]

);



if(result.rows.length===0)

return res.status(404).json({

success:false,

message:"Booking not found"

});



const booking =
result.rows[0];



// check charging status

if(
booking.booking_status !== "Charging"
)

return res.status(400).json({

success:false,

message:"Charging is not active"

});





// calculate energy

const duration =
Number(booking.duration || 0);


// Example charger power = 7kW

const energy =
Number(
(
7 *
(duration / 60)
)
.toFixed(2)
);



// charging cost

const ratePerUnit = 20;


const chargingAmount =
Number(
(
energy * ratePerUnit
)
.toFixed(2)
);



// platform fee

const platformFee =
Number(
(
chargingAmount * 0.10
)
.toFixed(2)
);



// owner amount

const ownerAmount =
Number(
(
chargingAmount - platformFee
)
.toFixed(2)
);







const updated =
await pool.query(

`
UPDATE bookings

SET

booking_status='Completed',

charging_status='completed',

units_consumed=$1,

amount_paid=$2,

platform_commission=$3,

owner_amount=$4

WHERE id=$5

RETURNING *

`,

[

energy,

chargingAmount,

platformFee,

ownerAmount,

bookingId

]

);





res.json({

success:true,

message:"Charging completed",

booking:
updated.rows[0]

});



}
catch(error){


console.log(
"COMPLETE CHARGING ERROR",
error
);



res.status(500).json({

success:false,

message:"Could not complete charging"

});


}


});





// =================================================
// GET ACTIVE CHARGING DETAILS
// =================================================


app.get(
"/charging/:bookingId",
async(req,res)=>{


try{


const result =
await pool.query(
`
SELECT *

FROM bookings

WHERE id=$1

`,
[
req.params.bookingId
]

);



if(result.rows.length===0)

return res.status(404).json({

success:false,

message:"Booking not found"

});



let booking =
result.rows[0];




// AUTO COMPLETE WHEN TIME FINISHES

if(

booking.booking_status==="Charging"

&&

booking.charging_end_time

&&

new Date(
booking.charging_end_time
)
<=
new Date()

){



const completed =
await pool.query(

`
UPDATE bookings

SET

booking_status='Completed',

charging_status='completed'

WHERE id=$1

RETURNING *

`

,
[
req.params.bookingId
]

);



booking =
completed.rows[0];


}



res.json({

success:true,

booking: booking

});



}
catch(error){


console.log(
"CHARGING FETCH ERROR",
error
);



res.status(500).json({

success:false,

message:"Charging details failed"

});


}


});
// =================================================
// COMPLETE CHARGING MANUALLY
// =================================================


app.put(
"/complete-charging/:bookingId",
async(req,res)=>{


try{


const result =
await pool.query(

`
UPDATE bookings

SET

booking_status='Completed',

charging_status='completed',

charging_end_time=NOW()

WHERE id=$1

RETURNING *

`

,
[
req.params.bookingId
]

);



if(result.rows.length===0)

return res.status(404).json({

success:false,

message:"Booking not found"

});




res.json({

success:true,

message:"Charging completed",

booking:
result.rows[0]

});



}
catch(error){


console.log(
"COMPLETE CHARGING ERROR",
error
);



res.status(500).json({

success:false,

message:"Completion failed"

});


}


});






// =================================================
// OWNER START CHARGING
// =================================================


app.put(
"/owner/start-charging/:bookingId",
async(req,res)=>{


try{


const result =
await pool.query(

`
SELECT *
FROM bookings
WHERE id=$1
`

,
[
req.params.bookingId
]

);



if(
booking.booking_status &&
booking.booking_status.toLowerCase() === "charging"
)

return res.status(400).json({

success:false,

message:"Already charging"

});


if(
booking.booking_status &&
booking.booking_status.toLowerCase() === "completed"
)

return res.status(400).json({

success:false,

message:"Charging already completed"

});


const duration =
Number(booking.duration);



const start =
new Date();



const end =
new Date(
start.getTime()
+
duration*60000
);




const updated =
await pool.query(

`
UPDATE bookings

SET

booking_status='Charging',

charging_status='charging',

charging_start_time=$1,

charging_end_time=$2

WHERE id=$3

RETURNING *

`

,
[

start,

end,

req.params.bookingId

]

);



res.json({

success:true,

booking:
updated.rows[0]

});



}
catch(error){


console.log(
"OWNER START ERROR",
error
);



res.status(500).json({

success:false,

message:"Owner start failed"

});


}


});







// =================================================
// OWNER COMPLETE CHARGING
// =================================================


app.put(
"/owner/complete-charging/:bookingId",
async(req,res)=>{


try{


const result =
await pool.query(

`
UPDATE bookings

SET

booking_status='Completed',

charging_status='completed',

charging_end_time=NOW()

WHERE id=$1

RETURNING *

`

,
[
req.params.bookingId
]

);



if(result.rows.length===0)

return res.status(404).json({

success:false,

message:"Booking not found"

});




res.json({

success:true,

booking:
result.rows[0]

});



}
catch(error){


console.log(
"OWNER COMPLETE ERROR",
error
);



res.status(500).json({

success:false,

message:"Owner complete failed"

});


}


});
// =================================================
// STATIONS
// =================================================


app.get("/stations", async(req,res)=>{

try{


const result =
await pool.query(

`
SELECT *
FROM stations
ORDER BY id
`

);



res.json(result.rows);


}
catch(error){


res.status(500).json({

message:"Could not fetch stations"

});


}


});





// =================================================
// SAVE PUSH TOKEN
// =================================================


app.post(
"/save-push-token",
async(req,res)=>{


try{


const {
userId,
expoPushToken
}=req.body;



await pool.query(

`
UPDATE users

SET expo_push_token=$1

WHERE id=$2

`

,
[
expoPushToken,
userId
]

);



res.json({

success:true

});


}
catch(error){


res.status(500).json({

success:false

});


}


});


app.post("/send-notification", async(req,res)=>{

try{

const {
userId,
title,
body
}=req.body;


const user =
await pool.query(
`
SELECT expo_push_token
FROM users
WHERE id=$1
`,
[userId]
);


const token =
user.rows[0]?.expo_push_token;


if(!token){

return res.json({
success:false,
message:"No token found"
});

}


await fetch(
"https://exp.host/--/api/v2/push/send",
{
method:"POST",
headers:{
"Content-Type":"application/json"
},
body:JSON.stringify({

to:token,

title:title,

body:body

})
});


res.json({
success:true
});


}
catch(error){

console.log(error);

res.status(500).json({
success:false
});

}

});



// =================================================
// OWNER STATIONS
// =================================================


app.get(
"/owner/stations/:ownerId",
async(req,res)=>{


try{


const result =
await pool.query(

`
SELECT *

FROM stations

WHERE owner_id=$1

ORDER BY id DESC

`

,
[
req.params.ownerId
]

);



res.json(result.rows);


}
catch(error){


res.status(500).json({

message:"Owner stations failed"

});


}


});






// =================================================
// OWNER BOOKINGS
// =================================================


app.get(
"/owner/bookings/:ownerId",
async(req,res)=>{


try{


const result =
await pool.query(

`
SELECT

b.*,

u.name AS customer_name,

u.email AS customer_email


FROM bookings b


JOIN stations s

ON s.id::text=b.station_id::text


LEFT JOIN users u

ON u.id::text=b.user_id::text


WHERE s.owner_id::text=$1::text


ORDER BY b.created_at DESC

`

,
[
req.params.ownerId
]

);



res.json(result.rows);



}
catch(error){


res.status(500).json({

message:"Owner bookings failed"

});


}


});







// =================================================
// OWNER REVENUE
// =================================================


app.get(
"/owner/revenue/:ownerId",
async(req,res)=>{


try{


const result =
await pool.query(

`
SELECT

COUNT(*)::int AS total_bookings,


COUNT(*) FILTER
(
WHERE LOWER(payment_status)
='success'
)::int AS paid_bookings,


COUNT(*) FILTER
(
WHERE LOWER(booking_status)
='charging'
)::int AS charging_sessions,


COUNT(*) FILTER
(
WHERE LOWER(booking_status)
='completed'
)::int AS completed_sessions,


COALESCE(
SUM(owner_amount),
0
)
AS revenue


FROM bookings b


JOIN stations s

ON s.id::text=b.station_id::text


WHERE s.owner_id::text=$1::text

`

,
[
req.params.ownerId
]

);



res.json(result.rows[0]);


}
catch(error){


res.status(500).json({

message:"Revenue failed"

});


}


});








// =================================================
// ADMIN DASHBOARD
// =================================================


app.get(
"/admin/dashboard",
async(req,res)=>{


try{


const result =
await pool.query(

`
SELECT


COUNT(*)::int AS total_bookings,


COUNT(*) FILTER
(
WHERE booking_status='Booked'
)::int AS booked,


COUNT(*) FILTER
(
WHERE booking_status='Charging'
)::int AS charging,


COUNT(*) FILTER
(
WHERE booking_status='Completed'
)::int AS completed,


COALESCE(
SUM(amount_paid),
0
)
AS revenue



FROM bookings

`

);



const data =
result.rows[0];



res.json({

totalBookings:data.total_bookings,

booked:data.booked,

charging:data.charging,

completed:data.completed,

revenue:data.revenue


});



}
catch(error){


res.status(500).json({

message:"Admin dashboard failed"

});


}


});







// =================================================
// ADMIN ALL BOOKINGS
// =================================================


app.get(
"/admin/bookings",
async(req,res)=>{


try{


const result =
await pool.query(

`
SELECT

id,

station_name,

vehicle,

date,

time,

payment_status,

booking_status,

duration


FROM bookings

ORDER BY id DESC

`

);



res.json(result.rows);


}
catch(error){


res.status(500).json({

message:"Bookings failed"

});


}


});






// =================================================
// ADMIN STATIONS
// =================================================


app.get(
"/admin/stations",
async(req,res)=>{


try{


const result =
await pool.query(

`
SELECT *

FROM stations

ORDER BY id DESC

`

);



res.json(result.rows);


}
catch(error){


res.status(500).json({

message:"Stations failed"

});


}


});








// =================================================
// ADD REVIEW
// =================================================


app.post(
"/reviews",
async(req,res)=>{


try{


const {

booking_id,

station_id,

user_id,

rating,

review

}=req.body;



const existing =
await pool.query(

`
SELECT id

FROM reviews

WHERE booking_id=$1

`

,
[
booking_id
]

);



if(existing.rows.length)

return res.status(400).json({

message:"Review already submitted"

});





const result =
await pool.query(

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

`

,
[

booking_id,

station_id,

user_id,

rating,

review || ""

]

);



res.json({

success:true,

review:result.rows[0]

});



}
catch(error){


res.status(500).json({

message:"Review failed"

});


}


});

// =====================================
// OWNER DASHBOARD
// =====================================

app.get(
"/owner/dashboard/:ownerId",
async(req,res)=>{


try{


const ownerId =
req.params.ownerId;



// total stations

const stations =
await pool.query(

`
SELECT COUNT(*) 
FROM stations
WHERE owner_id=$1

`,
[
ownerId
]

);




// total bookings

const bookings =
await pool.query(

`
SELECT COUNT(*)
FROM bookings b

JOIN stations s

ON b.station_id=s.id

WHERE s.owner_id=$1

`,
[
ownerId
]

);




// charging bookings

const charging =
await pool.query(

`
SELECT COUNT(*)
FROM bookings b

JOIN stations s

ON b.station_id=s.id

WHERE 
s.owner_id=$1

AND
b.booking_status='Charging'

`,
[
ownerId
]

);




// completed bookings

const completed =
await pool.query(

`
SELECT COUNT(*)
FROM bookings b

JOIN stations s

ON b.station_id=s.id

WHERE 
s.owner_id=$1

AND
b.booking_status='Completed'

`,
[
ownerId
]

);




// revenue

const revenue =
await pool.query(

`
SELECT 
COALESCE(SUM(b.owner_amount),0) AS total_revenue

FROM bookings b

JOIN stations s

ON b.station_id=s.id

WHERE 
s.owner_id=$1

AND
b.payment_status='success'

`,
[
ownerId
]

);



res.json({

success:true,

dashboard:{


totalStations:
Number(stations.rows[0].count),


totalBookings:
Number(bookings.rows[0].count),


chargingNow:
Number(charging.rows[0].count),


completed:
Number(completed.rows[0].count),

revenue:
Number(revenue.rows[0].total_revenue || 0)

}


});


}
catch(error){


console.log(
"OWNER DASHBOARD ERROR",
error
);


res.status(500).json({

success:false,

message:"Dashboard failed"

});


}


});




// =================================================
// SERVER START
// =================================================


app.listen(
PORT,
"0.0.0.0",
()=>{

console.log(
`Server running on http://0.0.0.0:${PORT}`
);

}
);