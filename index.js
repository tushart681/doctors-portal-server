const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
require('dotenv').config()
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const port = process.env.PORT || 5000;
const app = express()

app.use(cors())
app.use(express.json())

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.wez9mq6.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });
function verifyJWT(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.status(401).send('unauthorized access');
    }
    const token = authHeader.split(' ')[1];
    jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
        if (err) {
            return res.status(403).send({ message: 'forbidden access' })
        }
        req.decoded = decoded;
        next();
    })
}
async function run() {
    try {
        const appoinmentOptionCollection = client.db('doctorsPortal').collection('appoinmentOption')
        const bookingsCollection = client.db('doctorsPortal').collection('bookings')
        const usersCollection = client.db('doctorsPortal').collection('users')
        const doctorsCollection = client.db('doctorsPortal').collection('doctors')
        const paymentsCollection = client.db('doctorsPortal').collection('payments')

        const verifyAdmin = async(req, res, next) => {
            const decodedEmail = req.decoded.email;
            const query = { email: decodedEmail }
            const user = await usersCollection.findOne(query);
            if (user?.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access' })
            }
            next()

        }
        app.get('/appoinmentOption', async (req, res) => {
            const date = req.query.date;
            const query = {};
            const options = await appoinmentOptionCollection.find(query).toArray();
            const bookingQuery = { appoinmentDate: date }
            const alreadyBooked = await bookingsCollection.find(bookingQuery).toArray();
            options.forEach(option => {
                const optionBooked = alreadyBooked.filter(book => book.treatment === option.name)
                const bookedSlotes = optionBooked.map(book => book.slot)
                const reaminingSlots = option.slots.filter(slot => !bookedSlotes.includes(slot))
                option.slots = reaminingSlots
            })
            res.send(options)
        })
        app.get('/v2/appoinmentOption', async (req, res) => {
            const date = req.query.date;
            const options = await appoinmentOptionCollection.aggregate([
                {
                    $lookup: {
                        from: 'bookings',
                        localField: 'name',
                        foreignField: 'treatment',
                        pipeline: [
                            {
                                $match: {
                                    $expr: {
                                        $eq: ['$appoinmentDate', date]
                                    }
                                }
                            }
                        ],
                        as: 'booked'
                    }
                },
                {
                    $project: {
                        name: 1,
                        price: 1,
                        slots: 1,
                        booked: {
                            $map: {
                                input: '$booked',
                                as: 'book',
                                in: '$$book.slot'
                            }
                        }
                    }
                },
                {
                    $project: {
                        name: 1,
                        price: 1,
                        slots: {
                            $setDifference: ['$slots', '$booked']
                        }
                    }
                }
            ]).toArray();
            res.send(options)
        })
        app.get('/appoinmentSpecialty', async (req, res) => {
            const query = {};
            const result = await appoinmentOptionCollection.find(query).project({ name: 1 }).toArray();
            res.send(result)
        })
        app.get('/userBooked', verifyJWT, async (req, res) => {
            const email = req.query.email;
            const decodedEmail = req.decoded.email;
            if (email !== decodedEmail) {
                return res.status(403).send({ message: 'forbidden access' })
            }
            const query = {
                email: email
            }
            const bookingList = await bookingsCollection.find(query).toArray()
            res.send(bookingList)
        })
        app.get('/booking/:id', async(req, res) => {
            const id = req.params.id;
            const query = {_id: ObjectId(id)};
            const result = await bookingsCollection.findOne(query);
            res.send(result)
        })
        app.post('/bookings', async (req, res) => {
            const booking = req.body;
            const query = {
                appoinmentDate: booking.appoinmentDate,
                email: booking.email,
                treatment: booking.treatment
            }
            const alreadyBooked = await bookingsCollection.find(query).toArray();
            if (alreadyBooked.length) {
                const message = `you already booked have on ${booking.appoinmentDate}`
                return res.send({ acknowledged: false, message })
            }
            const result = await bookingsCollection.insertOne(booking);
            res.send(result)
        });
        app.post('/create-payment-intent', async (req, res) => {
            const booking = req.body;
            const price = booking.price;
            const amount = price * 100;
            const paymentIntent = await stripe.paymentIntents.create({
                currency: 'usd',
                amount: amount,
                'payment_method_types': [
                    'card'
                ]
            });
            res.send({
                clientSecret: paymentIntent.client_secret,
            });
        });
        app.post('/payments', async(req, res) => {
            const payment = req.body;
            const result = await paymentsCollection.insertOne(payment);
            const id = payment.bookingId;
            const filter = {_id: ObjectId(id)};
            const updatedoc = {
                $set: {
                    paid: true,
                    transactionId: payment.transactionId
                }
            }
            const updateResult = await bookingsCollection.updateOne(filter, updatedoc)
            res.send(result);
        })
        app.get('/jwt', async (req, res) => {
            const email = req.query.email;
            const query = {
                email: email
            }
            const user = await usersCollection.findOne(query)
            if (user) {
                const token = jwt.sign({ email }, process.env.ACCESS_TOKEN);
                return res.send({ accesstoken: token })
            }
            res.status(403).send({ accesstoken: '' })
        });
        app.get('/users', async (req, res) => {
            const query = {};
            const users = await usersCollection.find(query).toArray();
            res.send(users)
        })
        app.get('/users/admin/:email', async (req, res) => {
            const email = req.params.email;
            const query = { email };
            const user = await usersCollection.findOne(query);
            res.send({ isAdmin: user?.role === 'admin' });
        })
        app.post('/users', async (req, res) => {
            const user = req.body;
            const result = await usersCollection.insertOne(user);
            res.send(result)
        })
        app.put('/users/admin/:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: ObjectId(id) };
            const options = { upsert: true };
            const updatedoc = {
                $set: {
                    role: 'admin'
                }
            }
            const result = await usersCollection.updateOne(filter, updatedoc, options);
            res.send(result);
        })
        // app.get('/addPrice', async(req, res) => {
        //     const fuilter = {};
        //     const options = { upsert: true}
        //     const updatedoc = {
        //         $set: {
        //             price: 99
        //         }
        //     }
        //     const result = await appoinmentOptionCollection.updateMany(fuilter, updatedoc, options);
        //     res.send(result)
        // })
        app.get('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const query = {};
            const result = await doctorsCollection.find(query).toArray();
            res.send(result);
        })
        app.post('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const doctors = req.body;
            const result = await doctorsCollection.insertOne(doctors);
            res.send(result)
        })
        app.delete('/doctors/:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: ObjectId(id) };
            const result = await doctorsCollection.deleteOne(filter);
            res.send(result)
        })
    }
    finally { }
}
run().catch(console.log)


app.get('/', async (req, res) => {
    res.send('doctors portal is running')
})
app.listen(port, () => console.log(`portel is run on ${port}`))
