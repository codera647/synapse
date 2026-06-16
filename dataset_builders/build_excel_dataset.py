"""Generate ~16 small, realistic Excel datasets + a queries.xlsx whose answers are COMPUTED from the
actual generated data (so the ground truth is guaranteed correct). Sheets are kept small (15-25 rows)
so a RAG retriever can pull the relevant rows into context. Lookup-style questions dominate (one row
answers them); a few simple aggregates are included too.

Run:  python dataset_builders/build_excel_dataset.py
Out:  Excel_Files/*.xlsx  +  Excel_Files/queries.xlsx
"""
from __future__ import annotations

import os
import random

import pandas as pd

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "Excel_Files")
os.makedirs(OUT, exist_ok=True)
random.seed(42)

QUERIES: list[dict] = []
qid = 0


def add_q(question: str, answer: str, src: str):
    global qid
    qid += 1
    QUERIES.append({"query_id": f"xl_{qid:03d}", "question": question,
                    "reference_answer": str(answer), "source_file": src})


def save(df: pd.DataFrame, name: str):
    df.to_excel(os.path.join(OUT, name), index=False)
    return name


# 1) Employees ---------------------------------------------------------------------------------
names = ["Alice Carter","Brian Lee","Carmen Diaz","David Okafor","Emma Novak","Farid Hassan",
         "Grace Kim","Hugo Martin","Ivy Chen","Jack Wilson","Kira Petrova","Leo Santos"]
depts = ["Engineering","Sales","Marketing","Finance","HR","Engineering","Sales","Finance",
         "Engineering","Marketing","HR","Sales"]
salaries = [98000,72000,68000,85000,61000,103000,74000,88000,95000,69000,63000,77000]
emp = pd.DataFrame({"employee": names, "department": depts, "salary_usd": salaries,
                    "hire_year": [2019,2021,2020,2018,2022,2017,2021,2019,2016,2023,2020,2022]})
src = save(emp, "employees.xlsx")
top = emp.loc[emp.salary_usd.idxmax()]
add_q("What is the salary of David Okafor?", emp[emp.employee=="David Okafor"].salary_usd.iloc[0], src)
add_q("Which department does Ivy Chen work in?", emp[emp.employee=="Ivy Chen"].department.iloc[0], src)
add_q("Which employee has the highest salary and how much is it?", f"{top.employee} - ${top.salary_usd}", src)
add_q("How many employees work in the Engineering department?", int((emp.department=="Engineering").sum()), src)

# 2) Product inventory --------------------------------------------------------------------------
skus = [f"SKU-{1000+i}" for i in range(15)]
cats = ["Electronics","Electronics","Home","Home","Toys","Toys","Electronics","Home","Garden",
        "Garden","Toys","Electronics","Home","Garden","Toys"]
stock = [random.randint(0, 200) for _ in range(15)]
price = [round(random.uniform(5, 500), 2) for _ in range(15)]
inv = pd.DataFrame({"sku": skus, "category": cats, "stock_qty": stock, "unit_price_usd": price,
                    "reorder_level": [20]*15})
src = save(inv, "inventory.xlsx")
add_q("What category is SKU-1003?", inv[inv.sku=="SKU-1003"].category.iloc[0], src)
add_q("What is the stock quantity of SKU-1009?", int(inv[inv.sku=="SKU-1009"].stock_qty.iloc[0]), src)
add_q("How many SKUs are in the Garden category?", int((inv.category=="Garden").sum()), src)
below = inv[inv.stock_qty < inv.reorder_level]
add_q("How many products are below their reorder level of 20?", len(below), src)

# 3) Q1 sales transactions ----------------------------------------------------------------------
prods = ["Widget","Gadget","Gizmo","Sprocket","Cog"]
rows = []
for i in range(20):
    p = random.choice(prods); units = random.randint(1, 50); up = round(random.uniform(10, 60), 2)
    rows.append({"order_id": f"ORD-{2001+i}", "product": p, "units": units,
                 "unit_price": up, "revenue": round(units*up, 2)})
sales = pd.DataFrame(rows)
src = save(sales, "sales_q1.xlsx")
add_q("What product was ordered on order ORD-2005?", sales[sales.order_id=="ORD-2005"]["product"].iloc[0], src)
add_q("How many units were in order ORD-2012?", int(sales[sales.order_id=="ORD-2012"].units.iloc[0]), src)
add_q("What was the revenue of order ORD-2018?", sales[sales.order_id=="ORD-2018"].revenue.iloc[0], src)
add_q("What is the total revenue across all Q1 orders (rounded to 2 decimals)?", round(sales.revenue.sum(),2), src)

# 4) Student grades -----------------------------------------------------------------------------
students = ["Noah","Olivia","Priya","Quinn","Ravi","Sara","Tom","Uma","Victor","Wendy"]
math = [random.randint(50, 100) for _ in students]
sci = [random.randint(50, 100) for _ in students]
grades = pd.DataFrame({"student": students, "math": math, "science": sci})
grades["average"] = ((grades.math + grades.science)/2).round(1)
src = save(grades, "student_grades.xlsx")
add_q("What is Priya's math score?", int(grades[grades.student=="Priya"].math.iloc[0]), src)
add_q("What is Victor's average score?", grades[grades.student=="Victor"].average.iloc[0], src)
top_s = grades.loc[grades.average.idxmax()]
add_q("Which student has the highest average and what is it?", f"{top_s.student} - {top_s.average}", src)

# 5) Quarterly financial summary ----------------------------------------------------------------
fin = pd.DataFrame({"quarter": ["Q1","Q2","Q3","Q4"],
                    "revenue_usd": [120000,135000,128000,156000],
                    "cost_usd": [80000,88000,90000,99000]})
fin["profit_usd"] = fin.revenue_usd - fin.cost_usd
src = save(fin, "financial_summary.xlsx")
add_q("What was the revenue in Q3?", int(fin[fin.quarter=="Q3"].revenue_usd.iloc[0]), src)
add_q("What was the profit in Q4?", int(fin[fin.quarter=="Q4"].profit_usd.iloc[0]), src)
add_q("Which quarter had the highest profit?", fin.loc[fin.profit_usd.idxmax()].quarter, src)

# 6) Car sales ----------------------------------------------------------------------------------
cars = pd.DataFrame({
    "model": ["Civic","Corolla","Model 3","Mustang","Leaf","Camry","Golf","Sentra"],
    "year": [2022,2023,2023,2021,2022,2023,2020,2022],
    "price_usd": [26500,24800,41990,38500,28900,27600,23900,21500],
    "fuel": ["Petrol","Petrol","Electric","Petrol","Electric","Petrol","Petrol","Petrol"]})
src = save(cars, "car_sales.xlsx")
add_q("What is the price of the Model 3?", int(cars[cars.model=="Model 3"].price_usd.iloc[0]), src)
add_q("Which car models are electric?", ", ".join(cars[cars.fuel=="Electric"].model), src)
add_q("What year is the Mustang in this sheet?", int(cars[cars.model=="Mustang"].year.iloc[0]), src)

# 7) Restaurant menu ----------------------------------------------------------------------------
menu = pd.DataFrame({
    "item": ["Margherita Pizza","Caesar Salad","Beef Burger","Pasta Alfredo","Grilled Salmon",
             "Veggie Wrap","Tomato Soup","Cheesecake"],
    "category": ["Main","Starter","Main","Main","Main","Main","Starter","Dessert"],
    "price_usd": [12.5,8.0,14.0,13.5,18.5,9.5,6.0,7.5],
    "vegetarian": [True,True,False,True,False,True,True,True]})
src = save(menu, "restaurant_menu.xlsx")
add_q("What is the price of the Grilled Salmon?", menu[menu.item=="Grilled Salmon"].price_usd.iloc[0], src)
add_q("Is the Beef Burger vegetarian?", "No" if not menu[menu.item=="Beef Burger"].vegetarian.iloc[0] else "Yes", src)
add_q("How many vegetarian items are on the menu?", int(menu.vegetarian.sum()), src)

# 8) Gym members --------------------------------------------------------------------------------
gym = pd.DataFrame({
    "member_id": [f"M{100+i}" for i in range(12)],
    "name": names,
    "plan": ["Gold","Silver","Gold","Bronze","Silver","Gold","Bronze","Silver","Gold","Bronze","Silver","Gold"],
    "monthly_fee": [60,40,60,25,40,60,25,40,60,25,40,60]})
src = save(gym, "gym_members.xlsx")
add_q("What plan does member M105 have?", gym[gym.member_id=="M105"].plan.iloc[0], src)
add_q("What is the monthly fee for a Gold plan in this sheet?", int(gym[gym.plan=="Gold"].monthly_fee.iloc[0]), src)
add_q("How many members are on the Silver plan?", int((gym.plan=="Silver").sum()), src)

# 9) Library books ------------------------------------------------------------------------------
books = pd.DataFrame({
    "title": ["Dune","1984","Sapiens","The Hobbit","Clean Code","Deep Work","Atomic Habits","Hyperion"],
    "author": ["Frank Herbert","George Orwell","Yuval Harari","J.R.R. Tolkien","Robert Martin",
               "Cal Newport","James Clear","Dan Simmons"],
    "genre": ["SciFi","Dystopia","NonFiction","Fantasy","Tech","NonFiction","NonFiction","SciFi"],
    "copies": [4,7,3,5,2,3,6,2]})
src = save(books, "library_books.xlsx")
add_q("Who is the author of Sapiens?", books[books.title=="Sapiens"].author.iloc[0], src)
add_q("How many copies of 1984 are available?", int(books[books.title=="1984"].copies.iloc[0]), src)
add_q("Which books are in the SciFi genre?", ", ".join(books[books.genre=="SciFi"].title), src)

# 10) Monthly expenses --------------------------------------------------------------------------
exp = pd.DataFrame({
    "month": ["Jan","Feb","Mar","Apr","May","Jun"],
    "rent": [1500]*6, "utilities": [220,240,210,200,260,250],
    "groceries": [600,580,620,640,590,610]})
exp["total"] = exp.rent + exp.utilities + exp.groceries
src = save(exp, "monthly_expenses.xlsx")
add_q("What were the utilities in March?", int(exp[exp.month=="Mar"].utilities.iloc[0]), src)
add_q("What was the total expense in May?", int(exp[exp.month=="May"].total.iloc[0]), src)

# 11) Flight bookings ---------------------------------------------------------------------------
fl = pd.DataFrame({
    "booking": [f"BK{500+i}" for i in range(10)],
    "passenger": students,
    "route": ["LHR-JFK","DXB-LHR","SIN-SYD","JFK-LAX","CDG-DXB","LHR-DXB","SYD-SIN","LAX-JFK","DXB-CDG","JFK-LHR"],
    "fare_usd": [780,420,650,310,560,540,640,330,575,760]})
src = save(fl, "flight_bookings.xlsx")
add_q("What is the route for booking BK503?", fl[fl.booking=="BK503"].route.iloc[0], src)
add_q("What fare did Sara pay?", int(fl[fl.passenger=="Sara"].fare_usd.iloc[0]), src)

# 12) Customers ---------------------------------------------------------------------------------
cust = pd.DataFrame({
    "customer_id": [f"C{200+i}" for i in range(12)],
    "name": names, "city": ["London","Dubai","Berlin","Paris","Tokyo","Cairo","Seoul","Madrid",
                             "Shanghai","Chicago","Moscow","Lisbon"],
    "lifetime_value_usd": [4200,1800,3100,5600,900,2700,3300,4100,7800,1500,2200,3900]})
src = save(cust, "customers.xlsx")
add_q("Which city is customer C205 in?", cust[cust.customer_id=="C205"].city.iloc[0], src)
add_q("What is the lifetime value of Ivy Chen?", int(cust[cust.name=="Ivy Chen"].lifetime_value_usd.iloc[0]), src)
hv = cust.loc[cust.lifetime_value_usd.idxmax()]
add_q("Which customer has the highest lifetime value?", f"{hv['name']} ({hv.city}) - ${hv.lifetime_value_usd}", src)

# 13) Survey results ----------------------------------------------------------------------------
sv = pd.DataFrame({
    "respondent": [f"R{i+1}" for i in range(15)],
    "satisfaction": [random.randint(1, 5) for _ in range(15)],
    "would_recommend": [random.choice(["Yes","No"]) for _ in range(15)]})
src = save(sv, "survey_results.xlsx")
add_q("What satisfaction score did respondent R7 give?", int(sv[sv.respondent=="R7"].satisfaction.iloc[0]), src)
add_q("How many respondents said they would recommend (Yes)?", int((sv.would_recommend=="Yes").sum()), src)

# 14) Attendance --------------------------------------------------------------------------------
att = pd.DataFrame({
    "name": students,
    "present_days": [random.randint(15, 22) for _ in students],
    "total_days": [22]*len(students)})
att["attendance_pct"] = (att.present_days/att.total_days*100).round(1)
src = save(att, "attendance.xlsx")
add_q("How many days was Tom present?", int(att[att.name=="Tom"].present_days.iloc[0]), src)
add_q("What is Uma's attendance percentage?", att[att.name=="Uma"].attendance_pct.iloc[0], src)

# 15) Orders shipping ---------------------------------------------------------------------------
ship = pd.DataFrame({
    "order_id": [f"SH{900+i}" for i in range(12)],
    "destination": ["USA","UK","UAE","Germany","Japan","France","Korea","Spain","China","Canada","Russia","Portugal"],
    "weight_kg": [round(random.uniform(0.5, 25), 1) for _ in range(12)],
    "status": ["Delivered","In Transit","Delivered","Pending","Delivered","In Transit","Pending",
               "Delivered","In Transit","Delivered","Pending","Delivered"]})
src = save(ship, "shipping_orders.xlsx")
add_q("What is the destination of order SH903?", ship[ship.order_id=="SH903"].destination.iloc[0], src)
add_q("What is the status of order SH906?", ship[ship.order_id=="SH906"].status.iloc[0], src)
add_q("How many orders have been Delivered?", int((ship.status=="Delivered").sum()), src)

# 16) Product catalog with discounts ------------------------------------------------------------
cat = pd.DataFrame({
    "product": ["Laptop Pro","Wireless Mouse","Mechanical Keyboard","27in Monitor","USB-C Hub",
                "Webcam HD","Desk Lamp","Office Chair"],
    "list_price": [1499,29,89,329,49,69,39,219],
    "discount_pct": [10,0,15,5,0,20,10,12]})
cat["final_price"] = (cat.list_price*(1-cat.discount_pct/100)).round(2)
src = save(cat, "product_catalog.xlsx")
add_q("What is the list price of the 27in Monitor?", int(cat[cat["product"]=="27in Monitor"].list_price.iloc[0]), src)
add_q("What discount applies to the Mechanical Keyboard?", f"{int(cat[cat['product']=='Mechanical Keyboard'].discount_pct.iloc[0])}%", src)
add_q("What is the final price of the Webcam HD after discount?", cat[cat["product"]=="Webcam HD"].final_price.iloc[0], src)

# ---- write queries.xlsx -----------------------------------------------------------------------
pd.DataFrame(QUERIES).to_excel(os.path.join(OUT, "queries.xlsx"), index=False)
n_files = len([f for f in os.listdir(OUT) if f.endswith(".xlsx") and f != "queries.xlsx"])
print(f"Excel: wrote {n_files} datasets + queries.xlsx ({len(QUERIES)} queries) -> {OUT}")
