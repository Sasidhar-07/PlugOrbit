--
-- PostgreSQL database dump
--

\restrict sHhVAkhLvo8ICzqfHs3eHpfTcBsaP0IXCyh1sSSjGXwbTNVDDHybExXzhm7H6Bw

-- Dumped from database version 18.3 (Homebrew)
-- Dumped by pg_dump version 18.3 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: bookings; Type: TABLE; Schema: public; Owner: sasidhar
--

CREATE TABLE public.bookings (
    id integer NOT NULL,
    station_id character varying(50) NOT NULL,
    station_name character varying(255) NOT NULL,
    vehicle character varying(255) NOT NULL,
    date date NOT NULL,
    "time" character varying(20) NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    vehicle_type text,
    user_id integer,
    duration integer DEFAULT 30,
    payment_id text,
    order_id text,
    payment_status text DEFAULT 'pending'::text,
    booking_status text DEFAULT 'Booked'::text
);


ALTER TABLE public.bookings OWNER TO sasidhar;

--
-- Name: bookings_id_seq; Type: SEQUENCE; Schema: public; Owner: sasidhar
--

CREATE SEQUENCE public.bookings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.bookings_id_seq OWNER TO sasidhar;

--
-- Name: bookings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: sasidhar
--

ALTER SEQUENCE public.bookings_id_seq OWNED BY public.bookings.id;


--
-- Name: stations; Type: TABLE; Schema: public; Owner: sasidhar
--

CREATE TABLE public.stations (
    id integer NOT NULL,
    name character varying(255),
    address text,
    latitude numeric(10,8),
    longitude numeric(11,8),
    charger_type character varying(50),
    price_per_kwh integer,
    total_slots integer DEFAULT 5,
    owner_id integer,
    approval_status character varying(20) DEFAULT 'Pending'::character varying
);


ALTER TABLE public.stations OWNER TO sasidhar;

--
-- Name: stations_id_seq; Type: SEQUENCE; Schema: public; Owner: sasidhar
--

CREATE SEQUENCE public.stations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.stations_id_seq OWNER TO sasidhar;

--
-- Name: stations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: sasidhar
--

ALTER SEQUENCE public.stations_id_seq OWNED BY public.stations.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: sasidhar
--

CREATE TABLE public.users (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    email character varying(100) NOT NULL,
    phone character varying(20),
    password character varying(255) NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    role text DEFAULT 'customer'::text
);


ALTER TABLE public.users OWNER TO sasidhar;

--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: sasidhar
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.users_id_seq OWNER TO sasidhar;

--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: sasidhar
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: bookings id; Type: DEFAULT; Schema: public; Owner: sasidhar
--

ALTER TABLE ONLY public.bookings ALTER COLUMN id SET DEFAULT nextval('public.bookings_id_seq'::regclass);


--
-- Name: stations id; Type: DEFAULT; Schema: public; Owner: sasidhar
--

ALTER TABLE ONLY public.stations ALTER COLUMN id SET DEFAULT nextval('public.stations_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: sasidhar
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: bookings bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: sasidhar
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);


--
-- Name: stations stations_pkey; Type: CONSTRAINT; Schema: public; Owner: sasidhar
--

ALTER TABLE ONLY public.stations
    ADD CONSTRAINT stations_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: sasidhar
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: sasidhar
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: bookings bookings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: sasidhar
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- PostgreSQL database dump complete
--

\unrestrict sHhVAkhLvo8ICzqfHs3eHpfTcBsaP0IXCyh1sSSjGXwbTNVDDHybExXzhm7H6Bw

