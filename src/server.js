import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { User, Restaurant, Food, Order } from './models.js';
import { auth, admin, errorHandler } from './middleware.js';
import { authenticateGoogleCredential } from './services/googleAuth.js';

const app = express();
app.use(helmet()); app.use(compression()); app.use(cors({ origin: process.env.CLIENT_URL?.split(',') || 'http://localhost:5173' })); app.use(express.json({ limit: '1mb' })); app.use(morgan('dev'));
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
app.use('/api', limiter);
const emailSchema = z.string().email().max(254);
const safeUser = user => ({ id: user._id, name: user.name, email: user.email, role: user.role, phone: user.phone, addresses: user.addresses });
function tokenFor(user) { return jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: '7d', issuer: 'crumb-api', audience: 'crumb-client' }); }
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const geocodeCache = new Map();
let lastGeocodeRequestAt = 0;

app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'crumb-api' }));
app.get('/api/location/reverse', asyncRoute(async (req, res) => {
  const { latitude, longitude } = z.object({ latitude: z.coerce.number().min(-90).max(90), longitude: z.coerce.number().min(-180).max(180) }).parse(req.query);
  const key = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
  const cached = geocodeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return res.json(cached.result);
  const wait = 1000 - (Date.now() - lastGeocodeRequestAt);
  if (wait > 0) { res.set('Retry-After', String(Math.ceil(wait / 1000))); return res.status(429).json({ message: 'Location lookup is busy. Please try again in a moment.' }); }
  lastGeocodeRequestAt = Date.now();
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.search = new URLSearchParams({ format: 'jsonv2', lat: String(latitude), lon: String(longitude), zoom: '18', addressdetails: '1' }).toString();
  const response = await fetch(url, { headers: { 'User-Agent': process.env.NOMINATIM_USER_AGENT || 'CrumbFoodOrdering/1.0 (http://localhost:5173)', 'Referer': process.env.CLIENT_URL?.split(',')[0] || 'http://localhost:5173', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw Object.assign(new Error('Address lookup service is unavailable. Please enter your address manually.'), { status: 502 });
  const data = await response.json();
  if (!data.display_name) throw Object.assign(new Error('We could not find a street address here. Please enter it manually.'), { status: 404 });
  const result = { latitude, longitude, address: data.display_name, addressDetails: data.address || {} };
  geocodeCache.set(key, { result, expiresAt: Date.now() + 5 * 60 * 1000 });
  if (geocodeCache.size > 500) geocodeCache.delete(geocodeCache.keys().next().value);
  res.json(result);
}));
app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const data = z.object({ name: z.string().trim().min(2).max(80), email: emailSchema, password: z.string().min(8).max(72) }).parse(req.body);
  const user = await User.create({ ...data, email: data.email.toLowerCase(), password: await bcrypt.hash(data.password, 12) });
  res.status(201).json({ token: tokenFor(user), user: safeUser(user) });
}));
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const data = z.object({ email: emailSchema, password: z.string().min(1).max(72) }).parse(req.body);
  const user = await User.findOne({ email: data.email.toLowerCase() }).select('+password');
  if (!user || !user.active || !user.password || !(await bcrypt.compare(data.password, user.password))) return res.status(401).json({ message: 'Email or password is incorrect.' });
  res.json({ token: tokenFor(user), user: safeUser(user) });
}));
app.post('/api/auth/google', asyncRoute(async (req, res) => {
  const { credential } = z.object({ credential: z.string().min(20).max(5000) }).strict().parse(req.body);
  const user = await authenticateGoogleCredential(credential);
  res.json({ token: tokenFor(user), user: safeUser(user) });
}));
app.get('/api/auth/me', auth, (req, res) => res.json({ user: safeUser(req.user) }));
app.patch('/api/auth/me', auth, asyncRoute(async (req, res) => {
  const data = z.object({ name: z.string().trim().min(2).max(80).optional(), phone: z.string().max(30).optional(), addresses: z.array(z.object({ label: z.string().max(30), line: z.string().max(250), city: z.string().max(80), postalCode: z.string().max(20), latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional() })).max(10).optional() }).strict().parse(req.body);
  Object.assign(req.user, data); await req.user.save(); res.json({ user: safeUser(req.user) });
}));

app.get('/api/restaurants', asyncRoute(async (req, res) => {
  const { q, cuisine, category, sort, veg, minRating, promoted } = req.query;
  const filter = { isOpen: true };
  if (promoted === 'true') filter.promoted = true;
  if (q) {
    const safeQuery = escapeRegex(String(q).slice(0, 80));
    filter.$or = [
      { name: { $regex: safeQuery, $options: 'i' } },
      { cuisine: { $regex: safeQuery, $options: 'i' } },
      { tags: { $regex: safeQuery, $options: 'i' } },
    ];
    const matchingRestaurants = await Food.distinct('restaurant', {
      name: { $regex: safeQuery, $options: 'i' },
      available: true,
    });
    filter.$or.push({ _id: { $in: matchingRestaurants } });
  }
  if (cuisine && cuisine !== 'All') filter.cuisine = cuisine;
  if (category) filter.$and = [...(filter.$and || []), { $or: [{ tags: category }, { cuisine: category }] }];
  if (minRating) filter.rating = { $gte: Math.min(Number(minRating) || 0, 5) };
  let restaurants = await Restaurant.find(filter).lean();
  if (veg === 'true') {
    const [vegetarianIds, nonVegetarianIds] = await Promise.all([
      Food.distinct('restaurant', { veg: true, available: true }),
      Food.distinct('restaurant', { veg: false, available: true }),
    ]);
    restaurants = restaurants.filter(
      (restaurant) =>
        vegetarianIds.some((id) => String(id) === String(restaurant._id)) &&
        !nonVegetarianIds.some((id) => String(id) === String(restaurant._id)),
    );
  }
  if (sort === 'rating') restaurants.sort((a,b) => b.rating-a.rating); else if (sort === 'delivery') restaurants.sort((a,b) => parseInt(a.deliveryTime)-parseInt(b.deliveryTime)); else if (sort === 'price') restaurants.sort((a,b) => a.priceForTwo-b.priceForTwo); else restaurants.sort((a,b) => Number(b.promoted)-Number(a.promoted) || b.rating-a.rating);
  res.json({ restaurants, cuisines: await Restaurant.distinct('cuisine') });
}));
app.get('/api/restaurants/:id', asyncRoute(async (req, res) => {
  const restaurant = await Restaurant.findOne({ $or: [{ _id: req.params.id.match(/^[0-9a-f]{24}$/i) ? req.params.id : null }, { slug: req.params.id }] });
  if (!restaurant) return res.status(404).json({ message: 'Restaurant not found.' });
  const menu = await Food.find({ restaurant: restaurant._id, available: true }).sort({ category: 1, bestseller: -1 });
  res.json({ restaurant, menu });
}));
app.get('/api/foods', asyncRoute(async (req, res) => { const filter = { available: true }; if (req.query.veg === 'true') filter.veg = true; const foods = await Food.find(filter).populate('restaurant', 'name slug'); res.json({ foods }); }));

app.post('/api/orders', auth, asyncRoute(async (req, res) => {
  const data = z.object({ restaurantId: z.string().regex(/^[0-9a-f]{24}$/i), items: z.array(z.object({ foodId: z.string().regex(/^[0-9a-f]{24}$/i), quantity: z.number().int().min(1).max(50) })).min(1).max(60), address: z.string().trim().min(8).max(300), deliveryLocation: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).optional(), paymentMethod: z.enum(['card','cash']).default('card') }).parse(req.body);
  const restaurant = await Restaurant.findById(data.restaurantId); if (!restaurant || !restaurant.isOpen) return res.status(400).json({ message: 'This restaurant is currently unavailable.' });
  const ids = data.items.map(i => i.foodId); const foods = await Food.find({ _id: { $in: ids }, restaurant: restaurant._id, available: true });
  if (foods.length !== ids.length) return res.status(400).json({ message: 'One or more items are unavailable. Please refresh your cart.' });
  const byId = new Map(foods.map(f => [String(f._id), f]));
  const items = data.items.map(i => { const f = byId.get(i.foodId); return { food: f._id, name: f.name, image: f.image, price: f.price, quantity: i.quantity }; });
  const subtotal = items.reduce((n,i) => n + i.price*i.quantity, 0); const deliveryFee = subtotal >= 499 ? 0 : restaurant.deliveryFee; const tax = Math.round(subtotal * 0.05);
  const order = await Order.create({ user: req.user._id, restaurant: restaurant._id, items, subtotal, deliveryFee, tax, total: subtotal+deliveryFee+tax, address: data.address, deliveryLocation: data.deliveryLocation, paymentMethod: data.paymentMethod, eta: new Date(Date.now()+35*60*1000) });
  res.status(201).json({ order: await order.populate('restaurant','name image') });
}));
app.get('/api/orders', auth, asyncRoute(async (req, res) => { const orders = await Order.find({ user: req.user._id }).populate('restaurant','name image').sort({ createdAt: -1 }); res.json({ orders }); }));
app.get('/api/orders/:id', auth, asyncRoute(async (req,res) => { const filter = { _id: req.params.id }; if (req.user.role !== 'admin') filter.user = req.user._id; const order = await Order.findOne(filter).populate('restaurant','name image').populate('user','name email'); if(!order) return res.status(404).json({message:'Order not found.'}); res.json({order}); }));
app.patch('/api/orders/:id/cancel', auth, asyncRoute(async (req,res) => { const order = await Order.findOne({ _id:req.params.id, user:req.user._id }); if(!order) return res.status(404).json({message:'Order not found.'}); if(!['placed','confirmed'].includes(order.status)) return res.status(400).json({message:'This order can no longer be cancelled.'}); order.status='cancelled'; await order.save(); res.json({order}); }));

app.get('/api/admin/stats', auth, admin, asyncRoute(async (req,res) => { const [users,restaurants,foods,orders,revenue] = await Promise.all([User.countDocuments(),Restaurant.countDocuments(),Food.countDocuments(),Order.countDocuments(),Order.aggregate([{ $match:{status:{$ne:'cancelled'}}},{ $group:{_id:null,total:{$sum:'$total'}}}])]); res.json({stats:{users,restaurants,foods,orders,revenue:revenue[0]?.total||0}}); }));
app.get('/api/admin/users', auth, admin, asyncRoute(async(req,res)=>res.json({users:await User.find().sort({createdAt:-1})})));
app.patch('/api/admin/users/:id', auth, admin, asyncRoute(async(req,res)=>{const data=z.object({active:z.boolean()}).strict().parse(req.body);if(String(req.user._id)===req.params.id&&!data.active)return res.status(400).json({message:'You cannot disable your own admin account.'});const user=await User.findByIdAndUpdate(req.params.id,data,{new:true}).select('-password');if(!user)return res.status(404).json({message:'User not found.'});res.json({user});}));
app.get('/api/admin/orders', auth, admin, asyncRoute(async(req,res)=>res.json({orders:await Order.find().populate('user','name email').populate('restaurant','name').sort({createdAt:-1})})));
app.patch('/api/admin/orders/:id', auth, admin, asyncRoute(async(req,res)=>{const status=z.enum(['confirmed','preparing','on_the_way','delivered','cancelled']).parse(req.body.status);const order=await Order.findByIdAndUpdate(req.params.id,{status},{new:true}).populate('user','name email').populate('restaurant','name');if(!order)return res.status(404).json({message:'Order not found.'});res.json({order});}));
app.get('/api/admin/restaurants', auth, admin, asyncRoute(async(req,res)=>res.json({restaurants:await Restaurant.find().sort({createdAt:-1})})));
const restaurantInput = z.object({name:z.string().trim().min(2).max(120),slug:z.string().trim().min(2).max(140).regex(/^[a-z0-9-]+$/),cuisine:z.array(z.string().max(40)).min(1),description:z.string().max(500).optional(),image:z.string().url(),deliveryTime:z.string().max(40).optional(),deliveryFee:z.number().min(0).max(1000).optional(),priceForTwo:z.number().min(0).max(100000).optional(),rating:z.number().min(0).max(5).optional(),isOpen:z.boolean().optional(),promoted:z.boolean().optional()});
app.post('/api/admin/restaurants',auth,admin,asyncRoute(async(req,res)=>{const data=restaurantInput.parse(req.body);res.status(201).json({restaurant:await Restaurant.create(data)});}));
app.patch('/api/admin/restaurants/:id',auth,admin,asyncRoute(async(req,res)=>{const data=restaurantInput.partial().parse(req.body);const restaurant=await Restaurant.findByIdAndUpdate(req.params.id,data,{new:true,runValidators:true});if(!restaurant)return res.status(404).json({message:'Restaurant not found.'});res.json({restaurant});}));
app.delete('/api/admin/restaurants/:id',auth,admin,asyncRoute(async(req,res)=>{await Promise.all([Restaurant.findByIdAndDelete(req.params.id),Food.deleteMany({restaurant:req.params.id})]);res.json({message:'Restaurant and its menu removed.'});}));
app.get('/api/admin/foods',auth,admin,asyncRoute(async(req,res)=>res.json({foods:await Food.find().populate('restaurant','name').sort({createdAt:-1})})));
const foodInput=z.object({restaurant:z.string().regex(/^[0-9a-f]{24}$/i),name:z.string().trim().min(2).max(120),description:z.string().max(500).optional(),category:z.string().max(50).optional(),image:z.string().url(),price:z.number().min(0).max(100000),veg:z.boolean().optional(),bestseller:z.boolean().optional(),available:z.boolean().optional()});
app.post('/api/admin/foods',auth,admin,asyncRoute(async(req,res)=>{const data=foodInput.parse(req.body);if(!await Restaurant.exists({_id:data.restaurant}))return res.status(400).json({message:'Choose a valid restaurant.'});res.status(201).json({food:await Food.create(data)});}));
app.patch('/api/admin/foods/:id',auth,admin,asyncRoute(async(req,res)=>{const data=foodInput.partial().parse(req.body);const food=await Food.findByIdAndUpdate(req.params.id,data,{new:true,runValidators:true});if(!food)return res.status(404).json({message:'Food item not found.'});res.json({food});}));
app.delete('/api/admin/foods/:id',auth,admin,asyncRoute(async(req,res)=>{await Food.findByIdAndDelete(req.params.id);res.json({message:'Food item removed.'});}));
app.use((req,res)=>res.status(404).json({message:'That endpoint does not exist.'})); app.use(errorHandler);

const port=process.env.PORT||5000;
if(!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required. Copy .env.example to .env and set a secret.');
mongoose.connect(process.env.MONGODB_URI||'mongodb://127.0.0.1:27017/crumb').then(()=>app.listen(port,()=>console.log(`Crumb API listening on ${port}`))).catch(err=>{console.error('MongoDB connection failed:',err.message);process.exit(1);});
