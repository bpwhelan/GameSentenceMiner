#!/usr/bin/env python3
"""
Test script to verify the goals migration from localStorage to database.
This script tests the API endpoints and ensures data integrity.
"""

import json
import requests
import time
from datetime import datetime, timedelta

# Configuration
BASE_URL = "http://localhost:5000"  # Adjust if your app runs on different port

def test_api_endpoint(endpoint, method="GET", data=None, expected_status=200):
    """Test an API endpoint and return the response."""
    url = f"{BASE_URL}{endpoint}"
    
    try:
        if method == "GET":
            response = requests.get(url)
        elif method == "POST":
            response = requests.post(url, json=data)
        elif method == "PUT":
            response = requests.put(url, json=data)
        elif method == "DELETE":
            response = requests.delete(url)
        else:
            raise ValueError(f"Unsupported method: {method}")
        
        print(f"{'✓' if response.status_code == expected_status else '✗'} {method} {endpoint} - Status: {response.status_code}")
        
        if response.status_code != expected_status:
            print(f"  Expected: {expected_status}, Got: {response.status_code}")
            print(f"  Response: {response.text}")
        
        return response
    except Exception as e:
        print(f"✗ {method} {endpoint} - Error: {e}")
        return None

def test_goals_crud():
    """Test Create, Read, Update, Delete operations for goals."""
    print("\n=== Testing Goals CRUD Operations ===")
    
    # Test data
    test_goal = {
        "name": "Test Goal - Read 100K characters",
        "metricType": "characters",
        "targetValue": 100000,
        "startDate": "2025-01-01",
        "endDate": "2025-01-31",
        "icon": "📖"
    }
    
    # Test saving goals
    goals_settings = {
        "easyDays": {
            "monday": 100,
            "tuesday": 100,
            "wednesday": 100,
            "thursday": 100,
            "friday": 100,
            "saturday": 50,
            "sunday": 50
        },
        "ankiConnect": {
            "deckName": "Japanese::Mining"
        }
    }
    
    save_data = {
        "current_goals": [test_goal],
        "goals_settings": goals_settings
    }
    
    response = test_api_endpoint("/api/goals/save", "POST", save_data, 200)
    if response and response.status_code == 200:
        print("  ✓ Goals saved successfully")
    
    # Test retrieving latest goals
    response = test_api_endpoint("/api/goals/latest_goals", "GET", None, 200)
    if response and response.status_code == 200:
        data = response.json()
        if data.get("current_goals") and len(data["current_goals"]) > 0:
            print("  ✓ Goals retrieved successfully")
            print(f"  Found {len(data['current_goals'])} goals")
        else:
            print("  ✗ No goals found in response")
    
    # Test progress calculation
    progress_data = {
        "metric_type": "characters",
        "start_date": "2025-01-01",
        "end_date": "2025-01-31",
        "goals_settings": goals_settings
    }
    
    response = test_api_endpoint("/api/goals/progress", "POST", progress_data, 200)
    if response and response.status_code == 200:
        data = response.json()
        if "progress" in data:
            print("  ✓ Progress calculation works")
            print(f"  Progress: {data['progress']} characters")
        else:
            print("  ✗ Progress calculation failed")

def test_checkbox_states():
    """Test checkbox states for custom goals."""
    print("\n=== Testing Checkbox States ===")
    
    # Test data for checkbox states
    checkbox_states = {
        "goal_test_123": {
            "completionDates": ["2025-01-14", "2025-01-15"],
            "currentStreak": 2,
            "longestStreak": 5,
            "lastCheckedDate": "2025-01-15",
            "lastResetDate": "2025-01-15"
        }
    }
    
    # Test saving checkbox states
    response = test_api_endpoint("/api/goals/save-checkbox-states", "POST", 
                               {"checkbox_states": checkbox_states}, 200)
    if response and response.status_code == 200:
        print("  ✓ Checkbox states saved successfully")
    
    # Test retrieving checkbox states (via latest_goals)
    response = test_api_endpoint("/api/goals/latest_goals", "GET", None, 200)
    if response and response.status_code == 200:
        data = response.json()
        if data.get("goals_settings") and data["goals_settings"].get("checkboxStates"):
            print("  ✓ Checkbox states retrieved successfully")
            states = data["goals_settings"]["checkboxStates"]
            if "goal_test_123" in states:
                print(f"  Found test checkbox state with streak: {states['goal_test_123']['currentStreak']}")
            else:
                print("  ✗ Test checkbox state not found")
        else:
            print("  ✗ No checkbox states found")

def test_streak_functionality():
    """Test streak functionality."""
    print("\n=== Testing Streak Functionality ===")
    
    # Test getting current streak
    response = test_api_endpoint("/api/goals/current_streak", "GET", None, 200)
    if response and response.status_code == 200:
        data = response.json()
        if "streak" in data:
            print("  ✓ Current streak retrieved successfully")
            print(f"  Current streak: {data['streak']} days")
            print(f"  Longest streak: {data.get('longest_streak', 0)} days")
        else:
            print("  ✗ Streak data not found")
    
    # Test completing dailies
    test_goals = [{
        "name": "Test Daily Goal",
        "metricType": "custom",
        "icon": "✅"
    }]
    
    test_settings = {
        "easyDays": {
            "monday": 100, "tuesday": 100, "wednesday": 100,
            "thursday": 100, "friday": 100, "saturday": 100, "sunday": 100
        }
    }
    
    complete_data = {
        "current_goals": test_goals,
        "goals_settings": test_settings
    }
    
    response = test_api_endpoint("/api/goals/complete_todays_dailies", "POST", 
                               complete_data, 200)
    if response and response.status_code == 200:
        data = response.json()
        if data.get("success"):
            print("  ✓ Dailies completed successfully")
            print(f"  New streak: {data.get('streak', 0)} days")
        else:
            print("  ✗ Failed to complete dailies")
            print(f"  Error: {data.get('error', 'Unknown error')}")

def test_error_handling():
    """Test error handling for invalid requests."""
    print("\n=== Testing Error Handling ===")
    
    # Test invalid goal data
    invalid_goal = {
        "name": "",  # Empty name should fail validation
        "metricType": "invalid_type",  # Invalid metric type
        "targetValue": -100,  # Negative value
        "startDate": "2025-01-31",
        "endDate": "2025-01-01"  # End before start
    }
    
    response = test_api_endpoint("/api/goals/save", "POST", 
                               {"current_goals": [invalid_goal]}, 400)
    if response and response.status_code == 400:
        print("  ✓ Invalid goal data properly rejected")
    
    # Test missing required fields
    response = test_api_endpoint("/api/goals/progress", "POST", {}, 400)
    if response and response.status_code == 400:
        print("  ✓ Missing required fields properly rejected")

def run_all_tests():
    """Run all tests."""
    print("Starting Goals Migration Tests")
    print("=" * 50)
    
    # Wait a moment for the server to be ready
    time.sleep(1)
    
    # Test basic connectivity
    response = test_api_endpoint("/api/goals/latest_goals", "GET", None, 200)
    if not response or response.status_code != 200:
        print("\n✗ Cannot connect to the server. Make sure the application is running.")
        return False
    
    # Run all test suites
    test_goals_crud()
    test_checkbox_states()
    test_streak_functionality()
    test_error_handling()
    
    print("\n" + "=" * 50)
    print("Tests completed!")
    print("\nTo manually verify:")
    print("1. Open the goals page in your browser")
    print("2. Create a new goal and verify it saves")
    print("3. Check that goal progress is calculated correctly")
    print("4. Test custom goal checkboxes")
    print("5. Verify streak functionality works")
    print("6. Check that settings are preserved across page refreshes")
    
    return True

if __name__ == "__main__":
    run_all_tests()